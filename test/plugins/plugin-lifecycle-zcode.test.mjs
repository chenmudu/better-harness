import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { getHostProfile, getHostSurface, validateHostProfiles } from "../../scripts/host-support/index.mjs";
import {
  buildPluginLifecyclePlan,
  inspectPluginLifecycle,
  verifyPluginLifecycle,
} from "../../scripts/plugin-lifecycle/index.mjs";

const packageInfo = {
  name: "@qoderai/better-harness",
  version: "0.4.0",
  nodeRange: ">=22",
  npmRange: ">=10",
};

const baseOptions = {
  packageInfo,
  hostDiscovery: async () => "present",
  workspace: process.cwd(),
};

function plugin(overrides = {}) {
  return {
    id: "better-harness@better-harness",
    name: "better-harness",
    version: "0.4.0",
    enabled: true,
    installSources: ["user"],
    skills: [{ name: "better-harness" }],
    evidence: { path: path.join("fixture", "zcode", "plugins", "better-harness", "plugin.json") },
    ...overrides,
  };
}

function collectorWith(plugins = []) {
  return async ({ provider }) => ({ provider, plugins, diagnostics: {} });
}

test("ZCode declares one verified CLI marketplace surface", () => {
  assert.equal(validateHostProfiles(), true);
  const profile = getHostProfile("zcode");
  assert.equal(profile.managed, true);
  assert.deepEqual(profile.inventoryHomeRoutes, [
    { option: "zcodeHome", relativePath: "", fallbackLabel: "~/.zcode" },
    { option: "zcodeUserHome", relativePath: "", fallbackLabel: "~" },
  ]);
  assert.deepEqual(profile.surfaces.map((surface) => surface.surfaceId), ["cli"]);
  assert.equal(getHostSurface("zcode").observation.kind, "inventory");
  assert.deepEqual(getHostSurface("zcode").scopes, ["user", "project"]);
  for (const operationName of ["install", "update", "remove", "verify"]) {
    const operation = getHostSurface("zcode").lifecycle[operationName];
    assert.equal(operation.disposition, "supported", operationName);
    assert.ok(operation.contractEvidence, operationName);
  }
});

test("ZCode status distinguishes installed, absent, and unobserved inventory", async () => {
  const installed = await inspectPluginLifecycle({
    ...baseOptions,
    host: "zcode",
    inventoryCollector: collectorWith([plugin()]),
  });
  assert.equal(installed.rows.length, 1);
  assert.equal(installed.rows[0].target.scope, "user");
  assert.equal(installed.rows[0].installation, "installed");
  assert.equal(installed.rows[0].enablement, "enabled");
  assert.equal(installed.rows[0].verification, "partial");
  assert.ok(installed.rows[0].diagnostics.some((item) => item.code === "RUNTIME_ACTIVATION_UNOBSERVED"));

  const absent = await inspectPluginLifecycle({
    ...baseOptions,
    host: "zcode",
    inventoryCollector: collectorWith(),
  });
  assert.equal(absent.rows[0].installation, "not-installed");
  assert.equal(absent.rows[0].verification, "failed");
  assert.ok(absent.rows[0].diagnostics.some((item) => item.code === "PLUGIN_NOT_INSTALLED"));

  const unobserved = await inspectPluginLifecycle({
    ...baseOptions,
    host: "zcode",
    inventoryCollector: collectorWith([plugin({ installSources: [] })]),
  });
  assert.equal(unobserved.rows[0].installation, "unknown");
  assert.ok(unobserved.rows[0].diagnostics.some((item) => item.code === "INSTALL_SCOPE_UNSUPPORTED"));
});

test("ZCode status routes isolated inventory homes without falling back to the real home", async () => {
  let captured;
  const hostHome = path.join(process.cwd(), "fixture-zcode-home");
  await inspectPluginLifecycle({
    ...baseOptions,
    host: "zcode",
    hostHome,
    inventoryCollector: async (options) => {
      captured = options;
      return { provider: options.provider, plugins: [], diagnostics: {} };
    },
  });
  assert.equal(captured.provider, "zcode");
  assert.equal(captured.zcodeHome, hostHome);
  assert.equal(captured.zcodeUserHome, hostHome);
});

test("ZCode plans install, update, and remove with native marketplace argv", async () => {
  const install = await buildPluginLifecyclePlan({
    ...baseOptions,
    action: "install",
    host: "zcode",
    surface: "cli",
    scope: "user",
    inventoryCollector: collectorWith(),
  });
  assert.equal(install.state, "ready");
  assert.deepEqual(install.steps.map((step) => step.argv), [
    ["zcode", "plugins", "marketplace", "add", "https://github.com/QoderAI/better-harness.git", "--scope", "user"],
    ["zcode", "plugins", "install", "better-harness@better-harness", "--scope", "user"],
  ]);
  assert.equal(install.steps.every((step) => step.effects === "external"), true);
  assert.equal(install.verificationSteps[0].effects, "read-only");

  const update = await buildPluginLifecyclePlan({
    ...baseOptions,
    action: "update",
    host: "zcode",
    surface: "cli",
    scope: "project",
    inventoryCollector: collectorWith([plugin({ installSources: ["project"] })]),
  });
  assert.equal(update.state, "ready");
  assert.deepEqual(update.steps[0].argv, [
    "zcode", "plugins", "update", "better-harness@better-harness", "--scope", "project",
  ]);
  assert.equal(update.steps[0].cwd, process.cwd());

  const remove = await buildPluginLifecyclePlan({
    ...baseOptions,
    action: "remove",
    host: "zcode",
    surface: "cli",
    scope: "user",
    inventoryCollector: collectorWith([plugin()]),
  });
  assert.equal(remove.state, "ready");
  assert.deepEqual(remove.steps[0].argv, [
    "zcode", "plugins", "uninstall", "better-harness", "--scope", "user", "--force",
  ]);
});

test("ZCode update and remove stay honest when nothing is installed", async () => {
  const update = await buildPluginLifecyclePlan({
    ...baseOptions,
    action: "update",
    host: "zcode",
    surface: "cli",
    scope: "user",
    inventoryCollector: collectorWith(),
  });
  assert.equal(update.state, "blocked");
  assert.ok(update.blockers.some((item) => item.code === "PLUGIN_NOT_INSTALLED"));
  assert.deepEqual(update.steps, []);

  const remove = await buildPluginLifecyclePlan({
    ...baseOptions,
    action: "remove",
    host: "zcode",
    surface: "cli",
    scope: "user",
    inventoryCollector: collectorWith(),
  });
  assert.equal(remove.state, "noop");
  assert.deepEqual(remove.steps, []);
});

test("ZCode verify reports local plugin inventory and skips unknown surfaces", async () => {
  const verified = await verifyPluginLifecycle({
    ...baseOptions,
    host: "zcode",
    inventoryCollector: collectorWith([plugin()]),
  });
  assert.equal(verified.summary.targets, 1);
  assert.equal(verified.summary.partial, 1);
  assert.equal(verified.status, "partial");
  assert.ok(verified.diagnostics.some((item) => item.code === "RUNTIME_ACTIVATION_UNOBSERVED"));

  await assert.rejects(
    buildPluginLifecyclePlan({
      ...baseOptions,
      action: "install",
      host: "zcode",
      surface: "desktop",
      inventoryCollector: collectorWith(),
    }),
    (error) => error.code === "UNKNOWN_HOST_SURFACE",
  );
});

test("ZCode plans refuse an isolated host home it cannot bind", async () => {
  const plan = await buildPluginLifecyclePlan({
    ...baseOptions,
    action: "install",
    host: "zcode",
    surface: "cli",
    scope: "user",
    hostHome: path.join(process.cwd(), "fixture-zcode-home"),
    inventoryCollector: collectorWith(),
  });
  assert.equal(plan.state, "blocked");
  assert.ok(plan.blockers.some((item) => item.code === "ISOLATED_HOST_HOME_UNREPRESENTABLE"));
});

test("repository ships a ZCode-only marketplace file", async () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const [marketplace, pkg] = await Promise.all([
    readFile(path.join(repoRoot, "marketplace.json"), "utf8").then(JSON.parse),
    readFile(path.join(repoRoot, "package.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(marketplace.name, "better-harness");
  assert.equal(marketplace.plugins.length, 1);
  const plugin = marketplace.plugins[0];
  assert.equal(plugin.name, "better-harness");
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.source, "./");
  assert.equal(marketplace.owner.name, plugin.author.name);
});

test("repository ships the native ZCode plugin manifest", async () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const [zcode, claude, pkg] = await Promise.all([
    readFile(path.join(repoRoot, ".zcode-plugin", "plugin.json"), "utf8").then(JSON.parse),
    readFile(path.join(repoRoot, ".claude-plugin", "plugin.json"), "utf8").then(JSON.parse),
    readFile(path.join(repoRoot, "package.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(zcode.name, "better-harness");
  assert.equal(zcode.version, pkg.version);
  for (const key of ["name", "version", "description", "license"]) {
    assert.equal(zcode[key], claude[key], key);
  }
});
