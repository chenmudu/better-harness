import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  collectAgentCustomizeInventory,
  filterManageItems,
} from "../../scripts/agent-customize/index.mjs";
import { SUPPORTED_CUSTOMIZE_PROVIDERS } from "../../scripts/agent-customize/providers/index.mjs";
import { collectZcodeCustomizeInventory } from "../../scripts/agent-customize/providers/zcode.mjs";
import { HOST_CAPABILITIES, hostIdsFor } from "../../scripts/host-support/index.mjs";

const SECRET = "sk-live-zcode-secret-12345678";
const cliPath = path.join(process.cwd(), "scripts", "agent-customize", "cli.mjs");

async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function writeJson(filePath, value) {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeSkill(root, name, { description = `${name} description`, frontmatter = true } = {}) {
  const body = frontmatter
    ? `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
    : `# ${name}\n`;
  await writeText(path.join(root, name, "SKILL.md"), body);
}

async function makeDirectoryLink(target, linkPath) {
  await mkdir(path.dirname(linkPath), { recursive: true });
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

async function makeZcodeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "better-harness-zcode-customize-"));
  const zcodeHome = path.join(root, ".zcode");
  const userHome = root;
  const worktree = path.join(root, "repo");
  const workspace = path.join(worktree, "packages", "app");
  await mkdir(path.join(worktree, ".git"), { recursive: true });
  await mkdir(workspace, { recursive: true });

  // User instructions and skills.
  await writeText(path.join(zcodeHome, "AGENTS.md"), "USER INSTRUCTIONS\n");
  await writeSkill(path.join(zcodeHome, "skills"), "user-skill");
  await writeSkill(path.join(zcodeHome, "skills"), "shared");
  await writeSkill(path.join(zcodeHome, "skills"), "user-disabled");
  await writeSkill(path.join(userHome, ".agents", "skills"), "agents-skill");
  const extraSkillsRoot = path.join(root, "extra-skills");
  await writeSkill(extraSkillsRoot, "extra-skill");

  // User commands and subagents.
  await writeText(
    path.join(zcodeHome, "commands", "hello.md"),
    "---\ndescription: hello command\nargument-hint: <name>\n---\n\nHello $ARGUMENTS\n",
  );
  await writeText(
    path.join(zcodeHome, "commands", "disabled.md"),
    "---\ndescription: disabled command\n---\n\nDisabled\n",
  );
  await writeText(
    path.join(userHome, ".agents", "commands", "agents-cmd.md"),
    "---\ndescription: agents command\n---\n\nAgents\n",
  );
  await writeText(
    path.join(zcodeHome, "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: User reviewer\npermissionMode: bypassPermissions\n---\n\nReview.\n",
  );
  await writeText(
    path.join(zcodeHome, "agents", "disabled-agent.md"),
    "---\nname: disabled-agent\ndescription: Disabled agent\n---\n\nDisabled.\n",
  );
  await writeText(
    path.join(zcodeHome, "agents", "broken.md"),
    "---\nname: broken\n---\n\nMissing description.\n",
  );
  await writeJson(path.join(zcodeHome, "v2", "agents-state.json"), {
    disabledAgentIds: ["disabled-agent"],
  });

  // Project .zcode assets and compatibility .agents assets.
  await writeSkill(path.join(workspace, ".zcode", "skills"), "project-skill");
  await writeSkill(path.join(workspace, ".zcode", "skills"), "shared");
  await writeSkill(path.join(workspace, ".agents", "skills"), "compat-skill");
  await writeSkill(path.join(workspace, ".zcode", "skills", "top", "deep"), "too-deep");
  await writeText(
    path.join(workspace, ".zcode", "commands", "deploy.md"),
    "---\ndescription: deploy command\n---\n\nDeploy\n",
  );
  await writeText(
    path.join(workspace, ".zcode", "commands", "team", "release.md"),
    "---\ndescription: release command\n---\n\nRelease\n",
  );
  await writeText(
    path.join(workspace, ".zcode", "commands", "Bad Name.md"),
    "---\ndescription: invalid name\n---\n\nInvalid\n",
  );
  await writeText(
    path.join(workspace, ".agents", "commands", "agents-project.md"),
    "---\ndescription: agents project command\n---\n\nAgents project\n",
  );
  await writeText(
    path.join(workspace, ".zcode", "agents", "proj-agent.md"),
    "---\nname: proj-agent\ndescription: Project agent\npermissionMode: bypassPermissions\n---\n\nProject.\n",
  );
  await writeText(
    path.join(workspace, ".agents", "agents", "ignored.md"),
    "---\nname: ignored\ndescription: Must not load\n---\n\nIgnored.\n",
  );

  // AGENTS.md: workspace wins over the worktree root.
  await writeText(path.join(worktree, "AGENTS.md"), "ROOT INSTRUCTIONS\n");
  await writeText(path.join(workspace, "AGENTS.md"), `${"WORKSPACE ".repeat(12_000)}\n`);

  // Dead files that must never be inventoried.
  await writeJson(path.join(zcodeHome, "mcp.json"), {
    mcpServers: { "dead-user": { type: "stdio", command: "node" } },
  });
  await writeJson(path.join(zcodeHome, "hooks.json"), {
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node dead.js" }] }] },
  });
  await writeJson(path.join(workspace, ".zcode", "mcp.json"), {
    mcpServers: { "dead-project": { type: "stdio", command: "node" } },
  });
  await writeJson(path.join(workspace, ".zcode", "hooks.json"), {
    hooks: { Stop: [{ hooks: [{ type: "command", command: "node dead.js" }] }] },
  });

  const projectDisabledSkill = path.join(workspace, ".zcode", "skills", "shared", "SKILL.md");
  const userDisabledSkill = path.join(zcodeHome, "skills", "user-disabled", "SKILL.md");
  const userDisabledCommand = path.join(zcodeHome, "commands", "disabled.md");

  // User config: MCP, hooks, overrides, plugin enablement, extra skill root.
  await writeJson(path.join(zcodeHome, "cli", "config.json"), {
    mcp: {
      servers: {
        "user-server": {
          type: "stdio",
          command: "node",
          args: ["--token", SECRET],
          env: { API_TOKEN: SECRET, PLAIN_VALUE: "visible-key-name-only" },
        },
      },
    },
    hooks: {
      enabled: true,
      events: {
        SessionStart: [
          { hooks: [{ type: "command", command: `API_TOKEN=${SECRET} node hook.js` }] },
          { hooks: [{ type: "command", command: "node skipped.js", enabled: false }] },
        ],
      },
    },
    skill: {
      [userDisabledSkill]: { enable: false },
      [projectDisabledSkill]: { enable: false },
    },
    command: { [userDisabledCommand]: { enable: false } },
    plugins: {
      enabledPlugins: { "github@mkt": true, "superpowers@mkt": true },
    },
    skills: { enabled: true, roots: [extraSkillsRoot] },
  });

  // Project configs across root -> cwd.
  await writeJson(path.join(worktree, "zcode.json"), {
    mcp: { servers: { "root-server": { type: "stdio", command: "node", args: ["root.mjs"] } } },
    storage: { dir: "must-be-stripped" },
    permission: { mode: "bypassPermissions" },
  });
  await writeJson(path.join(worktree, "packages", ".zcode", "config.json"), {
    mcp: { servers: { "mid-server": { type: "stdio", command: "node" } } },
  });
  await writeJson(path.join(workspace, "zcode.json"), {
    plugins: { enabledPlugins: { "github@mkt": false } },
  });
  await writeJson(path.join(workspace, ".zcode", "config.json"), {
    mcp: { servers: { "app-server": { type: "stdio", command: "node", args: ["app.mjs"] } } },
    hooks: {
      enabled: true,
      events: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "node project-hook.js" }] },
        ],
      },
    },
    skill: { [projectDisabledSkill]: { enable: false } },
    plugins: { enabledPlugins: { "superpowers@mkt": true }, dirs: ["must-be-stripped"] },
    permission: { mode: "bypassPermissions" },
    toolConcurrency: { max: 2 },
  });

  // Installed plugins with components.
  const githubRoot = path.join(zcodeHome, "cli", "plugins", "cache", "mkt", "github", "1.0.0");
  await writeJson(path.join(githubRoot, ".zcode-plugin", "plugin.json"), {
    name: "github",
    version: "1.0.0",
    description: "GitHub plugin",
  });
  await writeSkill(path.join(githubRoot, "skills"), "plugin-skill");
  await writeText(
    path.join(githubRoot, "commands", "gh.md"),
    "---\ndescription: gh command\n---\n\ngh\n",
  );
  await writeText(
    path.join(githubRoot, "agents", "helper.md"),
    "---\nname: helper\ndescription: Plugin helper\n---\n\nHelp.\n",
  );
  await writeJson(path.join(githubRoot, "hooks", "hooks.json"), {
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "node plugin-hook.js" }] }],
  });
  await writeJson(path.join(githubRoot, ".mcp.json"), {
    mcpServers: { "plugin-server": { type: "stdio", command: "node", args: ["server.mjs"] } },
  });
  const superpowersRoot = path.join(zcodeHome, "cli", "plugins", "cache", "mkt", "superpowers", "2.0.0");
  await writeJson(path.join(superpowersRoot, ".zcode-plugin", "plugin.json"), {
    name: "superpowers",
    version: "2.0.0",
  });
  await writeJson(path.join(zcodeHome, "cli", "plugins", "installed_plugins.json"), {
    version: 1,
    plugins: [
      { id: "github@mkt", name: "github", marketplace: "mkt", version: "1.0.0", installPath: githubRoot, scope: "user" },
      { id: "superpowers@mkt", name: "superpowers", marketplace: "mkt", version: "2.0.0", installPath: superpowersRoot, scope: "user" },
    ],
  });

  return { root, zcodeHome, userHome, worktree, workspace, extraSkillsRoot };
}

test("ZCode inventory resolves homes and keeps storage root independent", async () => {
  const fixture = await makeZcodeFixture();
  try {
    const inventory = await collectAgentCustomizeInventory({
      provider: "zcode",
      zcodeHome: fixture.zcodeHome,
      workspace: fixture.workspace,
    });
    const direct = await collectZcodeCustomizeInventory({
      zcodeHome: fixture.zcodeHome,
      workspace: fixture.workspace,
    });

    assert.equal(inventory.provider, "zcode");
    assert.equal(direct.provider, "zcode");
    assert.equal(path.resolve(inventory.zcodeHome), path.resolve(fixture.zcodeHome));
    assert.equal(path.resolve(inventory.zcodeUserHome), path.resolve(fixture.userHome));
    assert.equal(path.resolve(inventory.storageRoot), path.resolve(fixture.zcodeHome));
    assert.ok(Array.isArray(inventory.tabs) && inventory.tabs.length > 0);
    assert.ok(inventory.manage.skills.length > 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ZCode discovers project configs root-to-cwd and strips user-only fields", async () => {
  const fixture = await makeZcodeFixture();
  try {
    const inventory = await collectZcodeCustomizeInventory({
      zcodeHome: fixture.zcodeHome,
      workspace: fixture.workspace,
    });

    assert.deepEqual(
      inventory.diagnostics.projectConfigFiles.map((filePath) => path.relative(fixture.worktree, filePath)),
      [
        path.join("zcode.json"),
        path.join("packages", ".zcode", "config.json"),
        path.join("packages", "app", "zcode.json"),
        path.join("packages", "app", ".zcode", "config.json"),
      ],
    );

    const ignored = inventory.diagnostics.ignoredProjectConfigKeys;
    assert.ok(ignored.some((entry) => entry.keys.includes("storage")));
    assert.ok(ignored.some((entry) => entry.keys.includes("permission")));
    assert.ok(ignored.some((entry) => entry.keys.includes("toolConcurrency")));
    assert.ok(inventory.diagnostics.ignoredProjectPluginKeys.some((entry) => entry.keys.includes("dirs")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ZCode project skills and commands include .agents compatibility roots and flag conflicts", async () => {
  const fixture = await makeZcodeFixture();
  try {
    const inventory = await collectZcodeCustomizeInventory({
      zcodeHome: fixture.zcodeHome,
      workspace: fixture.workspace,
    });

    const skillNames = inventory.manage.skills.map((item) => item.name);
    assert.ok(skillNames.includes("project-skill"));
    assert.ok(skillNames.includes("compat-skill"));
    assert.ok(skillNames.includes("plugin-skill"));
    assert.ok(skillNames.includes("user-skill"));
    assert.ok(skillNames.includes("extra-skill"));
    assert.equal(skillNames.includes("too-deep"), false);

    const shared = inventory.manage.skills.filter((item) => item.name === "shared");
    assert.equal(shared.length, 2);
    assert.ok(shared.every((item) => item.conflict === true));
    assert.ok(shared.every((item) => item.conflictWith.length === 1));

    const disabledShared = shared.find((item) => item.scope === "project");
    assert.equal(disabledShared.enabled, false);
    const disabledUser = inventory.manage.skills.find((item) => item.name === "user-disabled");
    assert.equal(disabledUser.enabled, false);

    const commands = inventory.manage.commands;
    assert.ok(commands.some((item) => item.name === "deploy" && item.scope === "project"));
    assert.ok(commands.some((item) => item.name === "team:release" && item.scope === "project"));
    assert.ok(commands.some((item) => item.name === "agents-cmd" && item.scope === "user"));
    assert.ok(commands.some((item) => item.name === "agents-project" && item.scope === "project"));
    assert.equal(commands.some((item) => item.name === "bad name"), false);
    assert.ok(inventory.diagnostics.invalidCommands.some((entry) => /Bad Name/u.test(entry.filePath)));
    assert.equal(commands.find((item) => item.name === "disabled").enabled, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ZCode project subagents use .zcode/agents only and strip project permissionMode", async () => {
  const fixture = await makeZcodeFixture();
  try {
    const inventory = await collectZcodeCustomizeInventory({
      zcodeHome: fixture.zcodeHome,
      workspace: fixture.workspace,
    });

    const names = inventory.manage.subagents.map((item) => item.name);
    assert.ok(names.includes("reviewer"));
    assert.ok(names.includes("proj-agent"));
    assert.ok(names.includes("helper"));
    assert.equal(names.includes("ignored"), false);

    const projectAgent = inventory.manage.subagents.find((item) => item.name === "proj-agent");
    assert.equal(projectAgent.permissionMode, undefined);
    assert.equal(projectAgent.permissionModeStripped, true);
    const userAgent = inventory.manage.subagents.find((item) => item.name === "reviewer");
    assert.equal(userAgent.permissionMode, "bypassPermissions");
    assert.equal(userAgent.enabled, true);
    assert.equal(inventory.manage.subagents.find((item) => item.name === "disabled-agent").enabled, false);
    assert.ok(inventory.diagnostics.invalidSubagents.some((entry) => /broken\.md/u.test(entry.filePath)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ZCode loads only the nearest workspace AGENTS.md and reports truncation", async () => {
  const fixture = await makeZcodeFixture();
  try {
    const inventory = await collectZcodeCustomizeInventory({
      zcodeHome: fixture.zcodeHome,
      workspace: fixture.workspace,
    });

    const rules = inventory.manage.rules;
    assert.equal(rules.length, 2);
    const userRule = rules.find((item) => item.scope === "user");
    const projectRule = rules.find((item) => item.scope === "project");
    assert.equal(path.resolve(userRule.filePath), path.resolve(fixture.zcodeHome, "AGENTS.md"));
    assert.equal(path.resolve(projectRule.filePath), path.resolve(fixture.workspace, "AGENTS.md"));
    assert.equal(projectRule.truncated, true);
    assert.ok(projectRule.byteSize > projectRule.maxBytes);
    assert.equal(rules.some((item) => item.filePath.includes(fixture.worktree) && !item.filePath.includes("packages")), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ZCode MCP inventory merges config sources, honors fallback, and redacts secrets", async () => {
  const fixture = await makeZcodeFixture();
  try {
    const inventory = await collectZcodeCustomizeInventory({
      zcodeHome: fixture.zcodeHome,
      workspace: fixture.workspace,
    });

    const names = inventory.manage.mcps.map((item) => item.name);
    assert.ok(names.includes("user-server"));
    assert.ok(names.includes("root-server"));
    assert.ok(names.includes("mid-server"));
    assert.ok(names.includes("app-server"));
    assert.ok(names.includes("plugin-server"));
    assert.equal(names.includes("dead-user"), false);
    assert.equal(names.includes("dead-project"), false);

    const userServer = inventory.manage.mcps.find((item) => item.name === "user-server");
    assert.deepEqual(userServer.envKeys, ["API_TOKEN", "PLAIN_VALUE"]);
    assert.deepEqual(userServer.directSecretEnvKeys, ["API_TOKEN"]);
    assert.deepEqual(userServer.args, ["<redacted>", "<redacted>"]);

    const serialized = JSON.stringify(inventory);
    assert.equal(serialized.includes(SECRET), false);
    assert.equal(serialized.includes("visible-key-name-only"), false);
    assert.equal(serialized.includes("must-be-stripped"), false);

    const fallbackRoot = await mkdtemp(path.join(os.tmpdir(), "better-harness-zcode-fallback-"));
    try {
      const fallbackHome = path.join(fallbackRoot, ".zcode");
      const fallbackWorkspace = path.join(fallbackRoot, "workspace");
      await mkdir(fallbackWorkspace, { recursive: true });
      await writeJson(path.join(fallbackRoot, ".agents", "mcp.json"), {
        mcpServers: { "user-fallback": { type: "stdio", command: "node" } },
      });
      await writeJson(path.join(fallbackWorkspace, ".agents", "mcp.json"), {
        mcpServers: { "project-fallback": { type: "stdio", command: "node" } },
      });
      const fallback = await collectZcodeCustomizeInventory({
        zcodeHome: fallbackHome,
        workspace: fallbackWorkspace,
      });
      assert.ok(fallback.manage.mcps.some((item) => item.name === "user-fallback" && item.scope === "user"));
      assert.ok(fallback.manage.mcps.some((item) => item.name === "project-fallback" && item.scope === "project"));
    } finally {
      await rm(fallbackRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ZCode hooks keep user, project, and plugin scopes with trust gating and redacted commands", async () => {
  const fixture = await makeZcodeFixture();
  try {
    const inventory = await collectZcodeCustomizeInventory({
      zcodeHome: fixture.zcodeHome,
      workspace: fixture.workspace,
    });

    const userHook = inventory.manage.hooks.find((item) => item.scope === "user" && item.event === "SessionStart");
    assert.ok(userHook);
    assert.equal(userHook.commandDisplay, "node hook.js");
    assert.equal(userHook.command, undefined);
    assert.equal(userHook.executable, true);
    assert.equal(userHook.trustGate, "none");
    assert.equal(inventory.manage.hooks.some((item) => item.commandDisplay === "node skipped.js" && item.enabled), false);

    const projectHook = inventory.manage.hooks.find((item) => item.scope === "project");
    assert.ok(projectHook);
    assert.equal(projectHook.trustGate, "workspace-trust-required");
    assert.equal(projectHook.executable, false);

    const pluginHook = inventory.manage.hooks.find((item) => item.scope === "plugin");
    assert.ok(pluginHook);
    assert.equal(pluginHook.commandDisplay, "node plugin-hook.js");
    assert.equal(pluginHook.executable, true);

    const serialized = JSON.stringify(inventory);
    assert.equal(serialized.includes(SECRET), false);
    assert.equal(serialized.includes("API_TOKEN="), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ZCode plugin records expose enabled state and component provenance without lifecycle actions", async () => {
  const fixture = await makeZcodeFixture();
  try {
    const inventory = await collectZcodeCustomizeInventory({
      zcodeHome: fixture.zcodeHome,
      workspace: fixture.workspace,
    });

    assert.equal(inventory.plugins.length, 2);
    const github = inventory.plugins.find((plugin) => plugin.name === "github");
    assert.equal(github.enabled, false);
    assert.equal(github.version, "1.0.0");
    assert.deepEqual(github.skills.map((item) => item.name), ["plugin-skill"]);
    assert.deepEqual(github.commands.map((item) => item.name), ["gh"]);
    assert.deepEqual(github.subagents.map((item) => item.name), ["helper"]);
    assert.equal(github.hooks.length, 1);
    assert.deepEqual(github.mcpServers.map((item) => item.name), ["plugin-server"]);
    assert.equal(inventory.plugins.find((plugin) => plugin.name === "superpowers").enabled, true);
    assert.equal(inventory.diagnostics.installedPluginRecordCount, 2);
    assert.ok(inventory.manage.skills.some((item) => item.pluginName === "github"));
    assert.ok(inventory.unsupported.some((entry) => /executing plugin install/iu.test(entry)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ZCode inventory reports unsupported surfaces and survives malformed inputs", async () => {
  const fixture = await makeZcodeFixture();
  try {
    const inventory = await collectZcodeCustomizeInventory({
      zcodeHome: fixture.zcodeHome,
      workspace: fixture.workspace,
    });

    for (const pattern of [/MCP live/iu, /hook trust/iu, /subagent runtime/iu, /remote workspace/iu]) {
      assert.ok(inventory.unsupported.some((entry) => pattern.test(entry)), String(pattern));
    }

    const malformedRoot = await mkdtemp(path.join(os.tmpdir(), "better-harness-zcode-malformed-"));
    try {
      const malformedHome = path.join(malformedRoot, ".zcode");
      const malformedWorkspace = path.join(malformedRoot, "workspace");
      await mkdir(path.join(malformedWorkspace, ".zcode"), { recursive: true });
      await writeText(path.join(malformedHome, "cli", "config.json"), "{not-json");
      await writeText(path.join(malformedWorkspace, ".zcode", "config.json"), "{not-json");
      const malformed = await collectZcodeCustomizeInventory({
        zcodeHome: malformedHome,
        workspace: malformedWorkspace,
      });
      assert.equal(malformed.diagnostics.invalidConfigFiles.length, 2);
      assert.deepEqual(malformed.manage.skills, []);
    } finally {
      await rm(malformedRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ZCode includeUserHome=false keeps project assets and drops user and plugin scope", async () => {
  const fixture = await makeZcodeFixture();
  try {
    const inventory = await collectZcodeCustomizeInventory({
      zcodeHome: fixture.zcodeHome,
      workspace: fixture.workspace,
      includeUserHome: false,
    });

    assert.equal(filterManageItems(inventory, { tab: "skills", scopeKind: "user" }).length, 0);
    assert.equal(filterManageItems(inventory, { tab: "mcps", scopeKind: "user" }).length, 0);
    assert.equal(inventory.plugins.length, 0);
    assert.ok(filterManageItems(inventory, { tab: "skills", scopeKind: "project" })
      .some((item) => item.name === "project-skill"));
    assert.equal(inventory.manage.rules.some((item) => item.scope === "user"), false);
    assert.equal(inventory.diagnostics.userConfigPath, null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ZCode deduplicates symlinked user skill and command roots by canonical path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "better-harness-zcode-symlink-"));
  const zcodeHome = path.join(root, ".zcode");
  const userHome = root;
  const workspace = path.join(root, "workspace");
  try {
    await mkdir(workspace, { recursive: true });
    await writeSkill(path.join(userHome, ".agents", "skills"), "shared-skill");
    await writeText(
      path.join(userHome, ".agents", "commands", "shared-command.md"),
      "---\ndescription: shared command\n---\n\nShared\n",
    );
    await makeDirectoryLink(path.join(userHome, ".agents", "skills"), path.join(zcodeHome, "skills"));
    await makeDirectoryLink(path.join(userHome, ".agents", "commands"), path.join(zcodeHome, "commands"));

    const inventory = await collectZcodeCustomizeInventory({ zcodeHome, workspace });
    assert.equal(inventory.manage.skills.filter((item) => item.name === "shared-skill").length, 1);
    assert.equal(inventory.manage.commands.filter((item) => item.name === "shared-command").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ZCode handles workspace and home paths with spaces and Unicode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "better-harness-zcode-unicode-"));
  const zcodeHome = path.join(root, "数据 home", ".zcode");
  const workspace = path.join(root, "工作 space", "repo");
  try {
    await mkdir(workspace, { recursive: true });
    await writeSkill(path.join(workspace, ".zcode", "skills"), "unicode-skill");
    await writeJson(path.join(zcodeHome, "cli", "config.json"), { skills: { enabled: true } });

    const inventory = await collectZcodeCustomizeInventory({ zcodeHome, workspace });
    const skill = inventory.manage.skills.find((item) => item.name === "unicode-skill");
    assert.ok(skill);
    assert.equal(skill.filePath.includes("工作 space"), true);
    assert.equal(path.resolve(inventory.workspace), path.resolve(workspace));
    assert.equal(path.resolve(inventory.zcodeHome), path.resolve(zcodeHome));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ZCode honors ZCODE_HOME and rejects empty or relative home overrides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "better-harness-zcode-env-"));
  const workspace = path.join(root, "workspace");
  const envHome = path.join(root, "env-home", ".zcode");
  const previous = process.env.ZCODE_HOME;
  try {
    await mkdir(workspace, { recursive: true });
    await writeSkill(path.join(envHome, "skills"), "env-skill");
    process.env.ZCODE_HOME = envHome;

    const inventory = await collectZcodeCustomizeInventory({ workspace });
    assert.equal(path.resolve(inventory.zcodeHome), path.resolve(envHome));
    assert.ok(inventory.manage.skills.some((item) => item.name === "env-skill"));

    await assert.rejects(
      () => collectZcodeCustomizeInventory({ zcodeHome: "", workspace }),
      /zcode-home must not be empty/u,
    );
    await assert.rejects(
      () => collectZcodeCustomizeInventory({ zcodeHome: "relative/home", workspace }),
      /zcode-home must be an absolute path/u,
    );
  } finally {
    if (previous === undefined) delete process.env.ZCODE_HOME;
    else process.env.ZCODE_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("ZCode inventories inline plugins.dirs and deduplicates them with installed records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "better-harness-zcode-inline-plugin-"));
  const zcodeHome = path.join(root, ".zcode");
  const workspace = path.join(root, "workspace");
  const inlineRoot = path.join(root, "inline-plugins", "custom-inline");
  try {
    await mkdir(workspace, { recursive: true });
    await writeJson(path.join(inlineRoot, ".zcode-plugin", "plugin.json"), {
      name: "custom-inline",
      version: "0.1.0",
      description: "Inline plugin",
    });
    await writeSkill(path.join(inlineRoot, "skills"), "inline-skill");
    await writeJson(path.join(zcodeHome, "cli", "config.json"), {
      plugins: { dirs: [inlineRoot] },
    });

    const inlineOnly = await collectZcodeCustomizeInventory({ zcodeHome, workspace });
    assert.equal(inlineOnly.plugins.length, 1);
    const inline = inlineOnly.plugins[0];
    assert.equal(inline.name, "custom-inline");
    assert.equal(inline.installMatch, "zcode-plugins-dirs");
    assert.deepEqual(inline.installSources, ["inline"]);
    assert.equal(inline.enabled, true);
    assert.deepEqual(inline.skills.map((item) => item.name), ["inline-skill"]);

    await writeJson(path.join(zcodeHome, "cli", "plugins", "installed_plugins.json"), {
      version: 1,
      plugins: [
        { id: "custom-inline@inline", name: "custom-inline", marketplace: "inline", installPath: inlineRoot, scope: "user" },
      ],
    });
    const deduped = await collectZcodeCustomizeInventory({ zcodeHome, workspace });
    assert.equal(deduped.plugins.length, 1);
    assert.deepEqual(deduped.plugins[0].installSources, ["inline", "user"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ZCode is registered for agent-customize and the CLI honors --zcode-home", async () => {
  assert.ok(SUPPORTED_CUSTOMIZE_PROVIDERS.includes("zcode"));
  assert.ok(hostIdsFor(HOST_CAPABILITIES.AGENT_CUSTOMIZE).includes("zcode"));

  const fixture = await makeZcodeFixture();
  try {
    const help = runCli(["--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--zcode-home/u);

    const result = runCli([
      "inventory",
      "--provider",
      "zcode",
      "--workspace",
      fixture.workspace,
      "--zcode-home",
      fixture.zcodeHome,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const inventory = JSON.parse(result.stdout);
    assert.equal(path.resolve(inventory.zcodeHome), path.resolve(fixture.zcodeHome));
    assert.notEqual(path.resolve(inventory.zcodeHome), path.join(os.homedir(), ".zcode"));
    assert.ok(inventory.manage.skills.some((item) => item.name === "project-skill"));
    assert.ok(inventory.manage.mcps.some((item) => item.name === "app-server"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
