/**
 * ZCode configured-asset inventory (read-only file scan).
 * Inventory home: --zcode-home, ZCODE_HOME, or ~/.zcode.
 * User compatibility root: <home>/.agents.
 * Project assets: <dir>/.zcode and <dir>/.agents from cwd to the worktree root.
 */
import os from "node:os";
import path from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";

import { expandHome, normalizeWorkspace, pathExists } from "../../session-analysis/index.mjs";
import { MANAGE_TABS } from "../constants.mjs";
import {
  buildManageCollections,
  collectMcpFromValue,
  collectRuleSources,
  collectSkillFiles,
  evidence,
  normalizePluginDisplayName,
  parseFrontmatter,
  readJson,
  readMarkdownName,
  readText,
  sanitizeMcpItems,
  sortByName,
  titleCase,
  uniqueAssetsByRealPath,
  workspaceSourceLabel,
} from "../core/items.mjs";

const COMMAND_EXTENSION = ".md";
const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9_:-]{0,63}$/u;
const COMMAND_MAX_DEPTH = 12;
const MAX_INSTRUCTION_BYTES = 100 * 1024;
const HOOK_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
]);
const PROJECT_CONFIG_KEYS = new Set(["mcp", "hooks", "skill", "command", "plugins", "skills"]);
const PLUGIN_MANIFEST_SHELLS = [
  ".zcode-plugin",
  ".claude-plugin",
  ".codex-plugin",
  ".cursor-plugin",
];
const PLUGIN_COMPONENTS = ["skills", "commands", "agents"];

export function defaultZcodeHome() {
  return process.env.ZCODE_HOME ?? path.join(os.homedir(), ".zcode");
}

function resolveHomeOption(value, label) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text) throw new TypeError(`${label} must not be empty`);
  const expanded = expandHome(text);
  if (!path.isAbsolute(expanded)) {
    throw new TypeError(`${label} must be an absolute path: ${text}`);
  }
  return path.resolve(expanded);
}

function emptyPrimitives() {
  return { skills: [], subagents: [], rules: [], commands: [], hooks: [], mcps: [] };
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function findWorktreeRoot(start) {
  let current = start;
  while (true) {
    if (await pathExists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** cwd -> worktree root, matching ZCode asset-root discovery. */
async function projectDirectories(workspace) {
  const worktreeRoot = await findWorktreeRoot(workspace);
  if (!worktreeRoot) return [workspace];
  const directories = [];
  let current = workspace;
  while (true) {
    directories.push(current);
    if (current === worktreeRoot || path.dirname(current) === current) break;
    current = path.dirname(current);
  }
  return directories;
}

/** root -> cwd, matching ZCode config merge order. */
function configDirectories(assetDirectories) {
  return [...assetDirectories].reverse();
}

async function readConfigFile(filePath, diagnostics, scope) {
  if (!(await pathExists(filePath))) return undefined;
  const config = await readJson(filePath);
  if (config === undefined) {
    diagnostics.invalidConfigFiles.push({ path: filePath, scope });
    return undefined;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    diagnostics.invalidConfigFiles.push({ path: filePath, scope });
    return undefined;
  }
  return config;
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function normalizeProjectConfig(config, filePath, diagnostics) {
  if (!isRecord(config)) return {};
  const blocked = Object.keys(config).filter((key) => !PROJECT_CONFIG_KEYS.has(key));
  if (blocked.length > 0) {
    diagnostics.ignoredProjectConfigKeys.push({ filePath, keys: blocked.sort() });
  }
  const projectPlugins = isRecord(config.plugins) ? config.plugins : undefined;
  const blockedPluginKeys = projectPlugins
    ? Object.keys(projectPlugins).filter((key) => !["enabledPlugins", "options"].includes(key))
    : [];
  if (blockedPluginKeys.length > 0) {
    diagnostics.ignoredProjectPluginKeys.push({ filePath, keys: blockedPluginKeys.sort() });
  }
  return {
    mcp: isRecord(config.mcp) ? config.mcp : undefined,
    hooks: isRecord(config.hooks) ? config.hooks : undefined,
    skill: isRecord(config.skill) ? config.skill : undefined,
    command: isRecord(config.command) ? config.command : undefined,
    plugins: projectPlugins
      ? {
          enabledPlugins: isRecord(projectPlugins.enabledPlugins)
            ? projectPlugins.enabledPlugins
            : undefined,
          options: isRecord(projectPlugins.options) ? projectPlugins.options : undefined,
        }
      : undefined,
    skills: isRecord(config.skills) ? config.skills : undefined,
  };
}

function collectDisabledPaths(maps, kind) {
  const disabled = new Set();
  for (const map of maps) {
    if (!isRecord(map)) continue;
    for (const [filePath, value] of Object.entries(map)) {
      if (isRecord(value) && value.enable === false) disabled.add(pathKey(filePath));
    }
  }
  return { kind, disabled };
}

function disabledMatches(item, disabled) {
  if (!item?.filePath || disabled.size === 0) return false;
  return disabled.has(pathKey(item.filePath));
}

async function markDisabled(items, disabledSets) {
  if (disabledSets.length === 0) return items;
  const result = [];
  for (const item of items) {
    let enabled = item.enabled !== false;
    for (const { kind, disabled } of disabledSets) {
      if (kind !== item.kind) continue;
      if (disabledMatches(item, disabled)) enabled = false;
    }
    result.push({ ...item, enabled });
  }
  return result;
}

async function collectZcodeSkills(root, scope, sourceLabel, rootForEvidence) {
  if (!(await pathExists(root))) return [];
  const items = await collectSkillFiles(root, scope, sourceLabel, rootForEvidence);
  // ZCode scans the root and one level of subdirectories only.
  return items.filter((item) => {
    const relative = path.relative(root, item.filePath);
    // A symlinked skill can resolve outside the scanned root; keep it.
    if (!relative || relative.startsWith("..")) return true;
    return relative.split(path.sep).length <= 2;
  });
}

async function collectZcodeCommands(root, scope, sourceLabel, rootForEvidence, diagnostics) {
  if (!(await pathExists(root))) return [];
  const files = [];
  async function walk(directory, depth) {
    if (depth > COMMAND_MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      diagnostics.commandScanFailures.push({
        path: directory,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(fullPath);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue;
        }
      }
      if (isDirectory) {
        await walk(fullPath, depth + 1);
      } else if (isFile && entry.name.toLowerCase().endsWith(COMMAND_EXTENSION)) {
        files.push(fullPath);
      }
    }
  }
  await walk(root, 0);

  const items = [];
  for (const filePath of files) {
    const relative = path.relative(root, filePath).slice(0, -COMMAND_EXTENSION.length);
    const name = relative.split(/[\\/]+/u).join(":").toLowerCase();
    if (!COMMAND_NAME_PATTERN.test(name)) {
      diagnostics.invalidCommands.push({ filePath, name });
      continue;
    }
    const text = await readText(filePath, 100_000);
    const metadata = parseFrontmatter(text);
    const heading = text.match(/^#\s+(.+)$/mu)?.[1]?.trim();
    items.push({
      id: `${scope}:command:${filePath}`,
      kind: "command",
      scope,
      sourceLabel,
      filePath,
      name,
      description: metadata.description ?? "",
      declaredName: heading && heading !== name ? heading : undefined,
      argumentHint: metadata["argument-hint"] ?? metadata.argumentHint,
      allowedTools: metadata["allowed-tools"] ?? metadata.allowedTools,
      model: metadata.model,
      skills: metadata.skills,
      frontmatterKeys: Object.keys(metadata).sort(),
      enabled: true,
      evidence: evidence(filePath, rootForEvidence),
    });
  }
  return items.sort(sortByName);
}

async function collectZcodeSubagents(root, scope, sourceLabel, rootForEvidence, diagnostics) {
  if (!(await pathExists(root))) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    diagnostics.subagentScanFailures.push({
      path: root,
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const filePath = path.join(root, entry.name);
    const text = await readText(filePath, 100_000);
    const metadata = parseFrontmatter(text);
    const name = typeof metadata.name === "string" ? metadata.name.trim() : "";
    const description = typeof metadata.description === "string" ? metadata.description.trim() : "";
    if (!name || !description) {
      diagnostics.invalidSubagents.push({
        filePath,
        missing: [!name ? "name" : null, !description ? "description" : null].filter(Boolean),
      });
      continue;
    }
    const permissionMode = typeof metadata.permissionMode === "string"
      ? metadata.permissionMode
      : undefined;
    items.push({
      id: `${scope}:subagent:${filePath}`,
      kind: "subagent",
      scope,
      sourceLabel,
      filePath,
      name,
      description,
      model: metadata.model,
      tools: metadata.tools,
      disallowedTools: metadata.disallowedTools,
      skills: metadata.skills,
      maxTurns: metadata.maxTurns,
      background: metadata.background,
      injectAgentsMd: metadata.injectAgentsMd,
      mcpServers: metadata.mcpServers,
      permissionMode: scope === "project" ? undefined : permissionMode,
      permissionModeStripped: scope === "project" && permissionMode !== undefined,
      enabled: true,
      evidence: evidence(filePath, rootForEvidence),
    });
  }
  return items.sort(sortByName);
}

function sanitizeHookCommand(command) {
  const tokens = String(command ?? "").match(/"[^"]*"|'[^']*'|\S+/gu)?.map((token) =>
    token.replace(/^["']|["']$/gu, "")
  ) ?? [];
  // Drop leading VAR=value assignments so their payload never reaches output.
  const executableIndex = tokens.findIndex((token) =>
    !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)
  );
  if (executableIndex === -1) return undefined;
  const executableToken = tokens[executableIndex];
  if (/[\s;|&<>]/u.test(executableToken)) return undefined;
  const executable = executableToken.split(/[\\/]/u).filter(Boolean).at(-1)?.toLowerCase() ?? "";
  if (!executable) return undefined;
  if (["node", "python", "python3", "bash", "sh", "zsh", "ruby", "powershell", "pwsh", "cmd"].includes(executable)) {
    const script = tokens.slice(executableIndex + 1).find((token) =>
      /\.(?:c?m?js|ts|py|sh|rb|ps1|cmd|bat)$/iu.test(token)
    );
    if (script) return `${executable} ${script.split(/[\\/]/u).filter(Boolean).at(-1)}`;
  }
  return executable;
}

function collectZcodeHooks(config, context, diagnostics) {
  const hooks = config?.hooks;
  if (!isRecord(hooks)) return [];
  // Native config uses hooks.events.<Event>; Claude-compatible plugin hook
  // files use hooks.<Event> directly.
  const events = isRecord(hooks.events)
    ? hooks.events
    : Object.keys(hooks).some((key) => HOOK_EVENTS.has(key))
      ? hooks
      : undefined;
  if (!events) {
    if (Object.keys(hooks).length > 0) {
      diagnostics.ignoredHookShapes.push({ filePath: context.filePath, keys: Object.keys(hooks).sort() });
    }
    return [];
  }
  const sourceEnabled = hooks.enabled !== false;
  const items = [];
  for (const [event, records] of Object.entries(events)) {
    if (!HOOK_EVENTS.has(event) || !Array.isArray(records)) continue;
    records.forEach((record, index) => {
      if (!isRecord(record)) return;
      const nestedHooks = Array.isArray(record.hooks) ? record.hooks : [record];
      nestedHooks.forEach((hook, hookIndex) => {
        if (!isRecord(hook)) return;
        const command = typeof hook.command === "string" ? hook.command : undefined;
        items.push({
          id: `${context.scope}:hook:${context.filePath}:${event}:${index}:${hookIndex}`,
          kind: "hook",
          scope: context.scope,
          sourceLabel: context.sourceLabel,
          event,
          step: event,
          label: record.matcher ? `${event} ${record.matcher}` : event,
          matcher: typeof record.matcher === "string" ? record.matcher : undefined,
          handlerType: typeof hook.type === "string" ? hook.type : command ? "command" : "unknown",
          commandDisplay: sanitizeHookCommand(command),
          command: undefined,
          enabled: sourceEnabled && hook.enabled !== false,
          trustGate: context.scope === "project" ? "workspace-trust-required" : "none",
          // Project hooks are configuration evidence only until trust is granted.
          executable: context.scope === "user" || context.scope === "plugin",
          timeoutMs: hook.timeoutMs ?? hook.timeout,
          async: hook.async,
          onError: hook.onError,
          shell: hook.shell,
          registrationIndex: index,
          hookIndex,
          filePath: context.filePath,
          evidence: evidence(context.filePath, context.rootForEvidence),
        });
      });
    });
  }
  return items.sort(sortByName);
}

function executableBasename(command) {
  const token = String(command ?? "").match(/"[^"]*"|'[^']*'|\S+/u)?.[0]
    ?.replace(/^["']|["']$/gu, "") ?? "";
  return token.split(/[\\/]/u).filter(Boolean).at(-1) ?? token;
}

function collectZcodeMcp(servers, scope, sourceLabel, filePath, rootForEvidence) {
  if (!isRecord(servers)) return [];
  const raw = collectMcpFromValue(servers, scope, sourceLabel, filePath, rootForEvidence);
  const commands = new Map(raw.map((item) => [item.id, item.command]));
  return sanitizeMcpItems(raw).map((item) => {
    const command = commands.get(item.id);
    return command ? { ...item, command: executableBasename(command) } : item;
  });
}

async function nearestAgentsMd(workspace) {
  let current = workspace;
  while (true) {
    const candidate = path.join(current, "AGENTS.md");
    if (await pathExists(candidate)) return candidate;
    if (await pathExists(path.join(current, ".git"))) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function decorateInstruction(rule, scope) {
  if (!rule?.filePath) return rule;
  try {
    const stats = await stat(rule.filePath);
    return {
      ...rule,
      byteSize: stats.size,
      truncated: stats.size > MAX_INSTRUCTION_BYTES,
      maxBytes: MAX_INSTRUCTION_BYTES,
      scope,
    };
  } catch {
    return rule;
  }
}

function extraSkillRoots(userConfig, workspace) {
  const roots = userConfig?.skills && Array.isArray(userConfig.skills.roots)
    ? userConfig.skills.roots
    : [];
  return roots
    .filter((root) => typeof root === "string" && root.trim())
    .map((root) => {
      const expanded = expandHome(root);
      return path.isAbsolute(expanded)
        ? path.resolve(expanded)
        : path.resolve(workspace, expanded);
    });
}

async function collectUserPrimitives({
  zcodeHome,
  zcodeUserHome,
  storageRoot,
  workspace,
  userConfig,
  diagnostics,
}) {
  const sourceLabel = "User";
  const disabledSkills = collectDisabledPaths([userConfig?.skill], "skill");
  const disabledCommands = collectDisabledPaths([userConfig?.command], "command");
  const [skills, commands, subagents, hooks] = await Promise.all([
    collectZcodeSkills(path.join(zcodeHome, "skills"), "user", sourceLabel, zcodeHome),
    collectZcodeCommands(path.join(zcodeHome, "commands"), "user", sourceLabel, zcodeHome, diagnostics),
    collectZcodeSubagents(path.join(storageRoot, "agents"), "user", sourceLabel, storageRoot, diagnostics),
    Promise.resolve(collectZcodeHooks(userConfig, {
      filePath: path.join(zcodeHome, "cli", "config.json"),
      scope: "user",
      sourceLabel,
      rootForEvidence: zcodeHome,
    }, diagnostics)),
  ]);
  const agentsSkills = await collectZcodeSkills(
    path.join(zcodeUserHome, ".agents", "skills"),
    "user",
    "User agents",
    zcodeUserHome,
  );
  const agentsCommands = await collectZcodeCommands(
    path.join(zcodeUserHome, ".agents", "commands"),
    "user",
    "User agents",
    zcodeUserHome,
    diagnostics,
  );
  const extraSkills = [];
  for (const root of extraSkillRoots(userConfig, workspace)) {
    extraSkills.push(...(await collectZcodeSkills(root, "project", "Configured skills root", root)));
  }
  const skillDisabled = userConfig?.skills?.enabled === false;
  const mergedSkills = await uniqueAssetsByRealPath([...skills, ...agentsSkills, ...extraSkills]);
  const mergedCommands = await uniqueAssetsByRealPath([...commands, ...agentsCommands]);
  return {
    skills: (await markDisabled(mergedSkills, [disabledSkills]))
      .map((item) => (skillDisabled ? { ...item, enabled: false } : item)),
    subagents,
    rules: [],
    commands: await markDisabled(mergedCommands, [disabledCommands]),
    hooks,
    mcps: [],
    disabledSkills,
    disabledCommands,
  };
}

async function collectProjectPrimitives({
  workspace,
  directories,
  projectConfigs,
  diagnostics,
}) {
  const sourceLabel = await workspaceSourceLabel(workspace);
  const primitiveSets = [];
  for (const directory of directories) {
    primitiveSets.push({
      skills: [
        ...(await collectZcodeSkills(path.join(directory, ".zcode", "skills"), "project", sourceLabel, workspace)),
        ...(await collectZcodeSkills(path.join(directory, ".agents", "skills"), "project", sourceLabel, workspace)),
      ],
      commands: [
        ...(await collectZcodeCommands(path.join(directory, ".zcode", "commands"), "project", sourceLabel, workspace, diagnostics)),
        ...(await collectZcodeCommands(path.join(directory, ".agents", "commands"), "project", sourceLabel, workspace, diagnostics)),
      ],
    });
  }
  const subagents = await collectZcodeSubagents(
    path.join(workspace, ".zcode", "agents"),
    "project",
    sourceLabel,
    workspace,
    diagnostics,
  );
  const agentsMd = await nearestAgentsMd(workspace);
  const rules = await collectRuleSources([
    ...(agentsMd
      ? [{
          type: "file",
          filePath: agentsMd,
          scope: "project",
          sourceLabel,
          rootForEvidence: workspace,
          name: "AGENTS.md",
          sourceKind: "zcode-workspace-instructions",
          precedence: "after-user-instructions",
          useHeading: true,
        }]
      : []),
  ]);
  const decoratedRules = [];
  for (const rule of rules) decoratedRules.push(await decorateInstruction(rule, "project"));

  const hooks = [];
  const mcps = [];
  for (const { filePath, config } of projectConfigs) {
    hooks.push(...collectZcodeHooks(config, {
      filePath,
      scope: "project",
      sourceLabel,
      rootForEvidence: workspace,
    }, diagnostics));
    mcps.push(...collectZcodeMcp(config.mcp?.servers, "project", sourceLabel, filePath, workspace));
  }
  const disabledSkills = collectDisabledPaths(projectConfigs.map(({ config }) => config.skill), "skill");
  const disabledCommands = collectDisabledPaths(projectConfigs.map(({ config }) => config.command), "command");
  const projectSkillToggles = projectConfigs.map(({ config }) => config.skills);
  const allSkills = await uniqueAssetsByRealPath(primitiveSets.flatMap((set) => set.skills));
  const allCommands = await uniqueAssetsByRealPath(primitiveSets.flatMap((set) => set.commands));
  const skills = await markDisabled(allSkills, [disabledSkills, ...projectSkillToggles
    .filter(isRecord)
    .map((toggle) => ({ kind: "skill", disabled: new Set(
      Object.entries(toggle)
        .filter(([key, value]) => path.isAbsolute(key) && isRecord(value) && value.enable === false)
        .map(([key]) => pathKey(key)),
    ) }))]);
  return {
    skills,
    subagents,
    rules: decoratedRules,
    commands: await markDisabled(allCommands, [disabledCommands]),
    hooks,
    mcps,
    disabledSkills,
    disabledCommands,
  };
}

function mergeEnabledPlugins(userConfig, projectConfigs) {
  const enabled = {};
  if (isRecord(userConfig?.plugins?.enabledPlugins)) {
    Object.assign(enabled, userConfig.plugins.enabledPlugins);
  }
  for (const { config } of projectConfigs) {
    if (isRecord(config.plugins?.enabledPlugins)) {
      Object.assign(enabled, config.plugins.enabledPlugins);
    }
  }
  return enabled;
}

async function readPluginManifest(pluginRoot) {
  for (const shell of PLUGIN_MANIFEST_SHELLS) {
    const manifestPath = path.join(pluginRoot, shell, "plugin.json");
    const manifest = await readJson(manifestPath);
    if (manifest && typeof manifest === "object") return { manifest, manifestPath };
  }
  return { manifest: undefined, manifestPath: undefined };
}

async function pluginComponentRoots(pluginRoot, manifest) {
  const roots = {};
  for (const component of PLUGIN_COMPONENTS) {
    const declared = manifest?.[component];
    const declaredPaths = Array.isArray(declared)
      ? declared
      : typeof declared === "string"
        ? [declared]
        : [];
    roots[component] = declaredPaths.length > 0
      ? declaredPaths.map((value) => path.resolve(pluginRoot, value))
      : [path.join(pluginRoot, component)];
  }
  return roots;
}

async function collectPluginRecord(record, enabledPlugins, diagnostics) {
  const pluginRoot = path.resolve(expandHome(record.installPath ?? ""));
  if (!record.installPath || !(await pathExists(pluginRoot))) {
    diagnostics.missingPluginRoots.push({ id: record.id, path: record.installPath ?? null });
    return undefined;
  }
  const { manifest, manifestPath } = await readPluginManifest(pluginRoot);
  const name = typeof manifest?.name === "string" && manifest.name.trim()
    ? manifest.name
    : record.name ?? path.basename(pluginRoot);
  const displayName = normalizePluginDisplayName(
    typeof manifest?.displayName === "string" ? manifest.displayName : titleCase(name),
    name,
  );
  const roots = await pluginComponentRoots(pluginRoot, manifest);
  const plugin = {
    id: record.id ?? `${name}@${record.marketplace ?? "unknown"}`,
    rootPath: pluginRoot,
    scope: "plugin",
    sourceLabel: displayName,
    name,
    displayName,
    description: typeof manifest?.description === "string" ? manifest.description : "",
    version: typeof manifest?.version === "string" ? manifest.version : record.version,
    publisher: record.marketplace ? { displayName: record.marketplace } : undefined,
    installSources: [record.installSource ?? record.scope ?? "user"],
    installSource: record.installSource ?? record.scope ?? "user",
    originSource: record.originSource ?? "installed-record",
    installMatch: record.installMatch ?? "zcode-installed-record",
    installType: record.installType ?? "marketplace",
    enabled: enabledPlugins[record.id] ?? true,
    evidence: evidence(manifestPath ?? pluginRoot, path.dirname(pluginRoot)),
  };
  plugin.skills = [];
  for (const root of roots.skills) {
    plugin.skills.push(...(await collectSkillFiles(root, "plugin", displayName, pluginRoot)));
  }
  plugin.skills.sort(sortByName);
  plugin.commands = [];
  for (const root of roots.commands) {
    plugin.commands.push(...(await collectMarkdownForPlugin(root, "command", displayName, pluginRoot, diagnostics)));
  }
  plugin.commands.sort(sortByName);
  plugin.subagents = [];
  for (const root of roots.agents) {
    plugin.subagents.push(...(await collectMarkdownForPlugin(root, "subagent", displayName, pluginRoot, diagnostics)));
  }
  plugin.subagents.sort(sortByName);
  plugin.rules = [];
  plugin.hooks = await collectPluginHooks(pluginRoot, manifest, displayName, diagnostics);
  plugin.mcpServers = await collectPluginMcp(pluginRoot, manifest, displayName, diagnostics);
  return plugin;
}

async function collectMarkdownForPlugin(root, kind, sourceLabel, rootForEvidence, diagnostics) {
  if (!(await pathExists(root))) return [];
  const files = [];
  async function walk(directory, depth) {
    if (depth > COMMAND_MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(COMMAND_EXTENSION)) {
        files.push(fullPath);
      }
    }
  }
  await walk(root, 0);
  const items = [];
  for (const filePath of files) {
    const fallback = path.basename(filePath, COMMAND_EXTENSION);
    const metadata = await readMarkdownName(filePath, fallback);
    items.push({
      id: `plugin:${kind}:${filePath}`,
      kind,
      scope: "plugin",
      sourceLabel,
      filePath,
      name: metadata.name ?? fallback,
      description: metadata.description,
      evidence: evidence(filePath, rootForEvidence),
    });
  }
  return items.sort(sortByName);
}

async function collectPluginHooks(pluginRoot, manifest, sourceLabel, diagnostics) {
  const sources = [];
  const declared = manifest?.hooks;
  if (typeof declared === "string") sources.push(path.resolve(pluginRoot, declared));
  if (Array.isArray(declared)) {
    for (const value of declared) {
      if (typeof value === "string") sources.push(path.resolve(pluginRoot, value));
    }
  }
  sources.push(path.join(pluginRoot, "hooks", "hooks.json"));
  const items = [];
  const seen = new Set();
  for (const filePath of sources) {
    if (seen.has(filePath) || !(await pathExists(filePath))) continue;
    seen.add(filePath);
    const raw = await readJson(filePath);
    if (!isRecord(raw)) {
      diagnostics.invalidPluginHookFiles.push(filePath);
      continue;
    }
    const config = isRecord(raw.hooks) ? raw : { hooks: raw };
    items.push(...collectZcodeHooks(config, {
      filePath,
      scope: "plugin",
      sourceLabel,
      rootForEvidence: pluginRoot,
    }, diagnostics));
  }
  return items.sort(sortByName);
}

async function collectPluginMcp(pluginRoot, manifest, sourceLabel, diagnostics) {
  const items = [];
  const mcpFile = path.join(pluginRoot, ".mcp.json");
  if (await pathExists(mcpFile)) {
    const raw = await readJson(mcpFile);
    if (isRecord(raw)) {
      items.push(...collectZcodeMcp(raw.mcpServers, "plugin", sourceLabel, mcpFile, pluginRoot));
    } else {
      diagnostics.invalidPluginMcpFiles.push(mcpFile);
    }
  }
  if (isRecord(manifest?.mcpServers)) {
    items.push(...collectZcodeMcp(
      manifest.mcpServers,
      "plugin",
      sourceLabel,
      path.join(pluginRoot, ".zcode-plugin", "plugin.json"),
      pluginRoot,
    ));
  }
  return items.sort(sortByName);
}

async function collectPlugins({
  storageRoot,
  includeUserHome,
  enabledPlugins,
  inlineDirs = [],
  diagnostics,
}) {
  if (!includeUserHome) return { plugins: [], recordFiles: [] };
  const pluginsRoot = path.join(storageRoot, "cli", "plugins");
  const recordFile = path.join(pluginsRoot, "installed_plugins.json");
  const raw = await readJson(recordFile);
  const records = [];
  if (isRecord(raw) && Array.isArray(raw.plugins)) {
    records.push(...raw.plugins.filter(isRecord));
  } else if (await pathExists(recordFile)) {
    diagnostics.invalidConfigFiles.push({ path: recordFile, scope: "plugins" });
  }
  for (const value of inlineDirs) {
    if (typeof value !== "string" || !value.trim()) continue;
    const pluginRoot = path.resolve(expandHome(value));
    const name = path.basename(pluginRoot);
    records.push({
      id: `${name}@inline`,
      name,
      marketplace: "inline",
      installPath: pluginRoot,
      scope: "user",
      installSource: "inline",
      installMatch: "zcode-plugins-dirs",
      installType: "inline",
      originSource: "inline-config",
    });
  }
  const byRealRoot = new Map();
  for (const record of records) {
    const plugin = await collectPluginRecord(record, enabledPlugins, diagnostics);
    if (!plugin) continue;
    const key = await realpath(plugin.rootPath).catch(() => path.resolve(plugin.rootPath));
    const existing = byRealRoot.get(key);
    if (!existing) {
      byRealRoot.set(key, plugin);
      continue;
    }
    const sources = new Set([
      ...(existing.installSources ?? [existing.installMatch]),
      ...(plugin.installSources ?? [plugin.installMatch]),
    ]);
    existing.installSources = [...sources].sort();
  }
  return {
    plugins: [...byRealRoot.values()].sort(sortByName),
    recordFiles: (await pathExists(recordFile)) ? [recordFile] : [],
  };
}

function conflictKey(item) {
  return String(item.name ?? item.displayName ?? "").trim().toLowerCase();
}

export function annotateAssetConflicts(items) {
  const groups = new Map();
  for (const item of items) {
    const key = conflictKey(item);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return items.map((item) => {
    const key = conflictKey(item);
    const peers = groups.get(key) ?? [];
    const distinctPaths = [...new Set(peers.map((peer) => peer.filePath ?? peer.evidence?.path).filter(Boolean))];
    if (distinctPaths.length <= 1) return item;
    return {
      ...item,
      conflict: true,
      conflictWith: distinctPaths
        .filter((filePath) => filePath !== (item.filePath ?? item.evidence?.path))
        .sort(),
    };
  });
}

function emptyDiagnostics() {
  return {
    invalidConfigFiles: [],
    ignoredProjectConfigKeys: [],
    ignoredProjectPluginKeys: [],
    ignoredHookShapes: [],
    invalidCommands: [],
    invalidSubagents: [],
    commandScanFailures: [],
    subagentScanFailures: [],
    missingPluginRoots: [],
    invalidPluginHookFiles: [],
    invalidPluginMcpFiles: [],
  };
}

export async function collectZcodeCustomizeInventory(options = {}) {
  const zcodeHome = resolveHomeOption(
    options.zcodeHome ?? options["zcode-home"],
    "zcode-home",
  ) ?? path.resolve(expandHome(defaultZcodeHome()));
  const zcodeUserHome = resolveHomeOption(
    options.zcodeUserHome ?? options["zcode-user-home"],
    "zcode-user-home",
  ) ?? path.dirname(zcodeHome);
  const workspace = normalizeWorkspace(options.workspace ?? process.cwd());
  const includeUserHome = options.includeUserHome !== false;
  const diagnostics = emptyDiagnostics();

  const userConfigPath = path.join(zcodeHome, "cli", "config.json");
  const userConfig = includeUserHome
    ? await readConfigFile(userConfigPath, diagnostics, "user")
    : undefined;
  const configuredStorage = typeof userConfig?.storage?.dir === "string"
    ? path.resolve(expandHome(userConfig.storage.dir))
    : zcodeHome;
  const storageRoot = configuredStorage;

  const directories = await projectDirectories(workspace);
  const configs = [];
  for (const directory of configDirectories(directories)) {
    for (const fileName of ["zcode.json", path.join(".zcode", "config.json")]) {
      const filePath = path.join(directory, fileName);
      const raw = await readConfigFile(filePath, diagnostics, "project");
      if (raw === undefined) continue;
      const config = normalizeProjectConfig(raw, filePath, diagnostics);
      configs.push({ filePath, config });
    }
  }
  if (options.projectConfigPath) {
    const explicitPath = path.resolve(expandHome(options.projectConfigPath));
    if (!configs.some(({ filePath }) => pathKey(filePath) === pathKey(explicitPath))) {
      const raw = await readConfigFile(explicitPath, diagnostics, "project");
      if (raw !== undefined) {
        const config = normalizeProjectConfig(raw, explicitPath, diagnostics);
        configs.push({ filePath: explicitPath, config });
      }
    }
  }

  const user = includeUserHome
    ? await collectUserPrimitives({ zcodeHome, zcodeUserHome, storageRoot, workspace, userConfig, diagnostics })
    : { ...emptyPrimitives(), disabledSkills: new Set(), disabledCommands: new Set() };
  const project = await collectProjectPrimitives({
    workspace,
    directories,
    projectConfigs: configs,
    diagnostics,
  });

  const userRules = [];
  if (includeUserHome) {
    const userAgentsMd = path.join(zcodeHome, "AGENTS.md");
    if (await pathExists(userAgentsMd)) {
      const rules = await collectRuleSources([{
        type: "file",
        filePath: userAgentsMd,
        scope: "user",
        sourceLabel: "User",
        rootForEvidence: zcodeHome,
        name: "AGENTS.md",
        sourceKind: "zcode-user-instructions",
        precedence: "before-workspace-instructions",
        useHeading: true,
      }]);
      for (const rule of rules) userRules.push(await decorateInstruction(rule, "user"));
    }
  }
  user.rules = userRules;

  const userMcps = includeUserHome
    ? collectZcodeMcp(userConfig?.mcp?.servers, "user", "User", userConfigPath, zcodeHome)
    : [];
  if (includeUserHome && userMcps.length === 0) {
    const agentsMcp = path.join(zcodeUserHome, ".agents", "mcp.json");
    if (await pathExists(agentsMcp)) {
      const raw = await readJson(agentsMcp);
      if (isRecord(raw)) {
        userMcps.push(...collectZcodeMcp(raw.mcpServers, "user", "User agents", agentsMcp, zcodeUserHome));
      } else {
        diagnostics.invalidConfigFiles.push({ path: agentsMcp, scope: "user" });
      }
    }
  }
  user.mcps = userMcps;

  if (project.mcps.length === 0) {
    const agentsMcp = path.join(workspace, ".agents", "mcp.json");
    if (await pathExists(agentsMcp)) {
      const raw = await readJson(agentsMcp);
      if (isRecord(raw)) {
        project.mcps.push(...collectZcodeMcp(raw.mcpServers, "project", await workspaceSourceLabel(workspace), agentsMcp, workspace));
      } else {
        diagnostics.invalidConfigFiles.push({ path: agentsMcp, scope: "project" });
      }
    }
  }

  const enabledPlugins = mergeEnabledPlugins(includeUserHome ? userConfig : undefined, configs);
  const pluginPack = await collectPlugins({
    storageRoot,
    includeUserHome,
    enabledPlugins,
    inlineDirs: userConfig?.plugins?.dirs,
    diagnostics,
  });
  const plugins = pluginPack.plugins;
  const manage = buildManageCollections(plugins, user, project);
  manage.skills = annotateAssetConflicts(manage.skills);
  manage.commands = annotateAssetConflicts(manage.commands);
  manage.subagents = annotateAssetConflicts(manage.subagents);
  manage.mcps = annotateAssetConflicts(manage.mcps);

  const agentsStatePath = path.join(storageRoot, "v2", "agents-state.json");
  const agentsState = includeUserHome ? await readJson(agentsStatePath) : undefined;
  if (Array.isArray(agentsState?.disabledAgentIds) && agentsState.disabledAgentIds.length > 0) {
    const disabled = new Set(agentsState.disabledAgentIds.map((id) => String(id)));
    manage.subagents = manage.subagents.map((item) =>
      disabled.has(item.name) ? { ...item, enabled: false } : item
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    provider: "zcode",
    zcodeHome,
    zcodeUserHome,
    storageRoot,
    workspace,
    tabs: MANAGE_TABS,
    plugins,
    manage,
    diagnostics: {
      ...diagnostics,
      userConfigPath: includeUserHome && (await pathExists(userConfigPath)) ? userConfigPath : null,
      projectConfigFiles: configs.map(({ filePath }) => filePath),
      assetDirectories: directories,
      disabledSkillPaths: [...user.disabledSkills?.disabled ?? []],
      disabledCommandPaths: [...user.disabledCommands?.disabled ?? []],
      installedPluginState: plugins.length > 0 ? "zcode-installed-records" : "missing",
      installedPluginRecordCount: plugins.length,
      installedPluginRecordFiles: pluginPack.recordFiles,
    },
    unsupported: [
      "MCP live connection status and tool counts (requires a running ZCode host)",
      "MCP OAuth pending state",
      "workspace hook trust decisions and digests; inventory reports configured/trust-gated only",
      "subagent runtime snapshots and built-in fallback profiles",
      "remote workspace assets",
      "executing plugin install, update, or uninstall; Better Harness emits external lifecycle plans only",
      "effective same-name resolution differences between CLI runtime and desktop settings paths",
      "official bundled plugins that have no installed record",
    ],
  };
}
