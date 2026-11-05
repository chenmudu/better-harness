import {
  BETTER_HARNESS_REPOSITORY,
  defineHostProfile,
  defineSurface,
  evidence,
  operation,
  shell,
} from "../profile-builders.mjs";

// The ZCode CLI resolves ~/.zcode/cli through homedir() and exposes no
// config-root environment override, so lifecycle plans cannot bind an isolated
// host home. Inventory reads stay isolated through --zcode-home.
export default defineHostProfile({
  hostId: "zcode",
  aliases: ["z-code"],
  displayName: "ZCode",
  provider: "zcode",
  inventoryHomeRoutes: [
    { option: "zcodeHome", relativePath: "", fallbackLabel: "~/.zcode" },
    { option: "zcodeUserHome", relativePath: "", fallbackLabel: "~" },
  ],
  managed: true,
  executables: ["zcode"],
  surfaces: [defineSurface({
    surfaceId: "cli",
    displayName: "ZCode CLI",
    distributionKind: "marketplace",
    scopes: ["user", "project"],
    defaultScope: "user",
    lifecycle: {
      install: operation("supported", [
        shell(
          ["zcode", "plugins", "marketplace", "add", BETTER_HARNESS_REPOSITORY, "--scope", "{scope}"],
          "The Better Harness marketplace is registered for the selected scope.",
        ),
        shell(
          ["zcode", "plugins", "install", "better-harness@better-harness", "--scope", "{scope}"],
          "The Better Harness plugin is installed and enabled at the selected scope.",
        ),
      ], evidence("zcode-plugin-install", "native-cli-help-with-isolated-smoke")),
      update: operation("supported", [
        shell(
          ["zcode", "plugins", "update", "better-harness@better-harness", "--scope", "{scope}"],
          "The plugin is updated to the latest marketplace version; a new session is required.",
        ),
      ], evidence("zcode-plugin-update", "native-cli-help-with-isolated-smoke")),
      remove: operation("supported", [
        shell(
          ["zcode", "plugins", "uninstall", "better-harness", "--scope", "{scope}", "--force"],
          "Only the selected Better Harness installation is removed; --force skips the interactive confirmation.",
        ),
      ], evidence("zcode-plugin-uninstall", "native-cli-help-with-isolated-smoke")),
      verify: operation("supported", [
        shell(
          ["zcode", "plugins", "list", "--json"],
          "The installed plugin inventory reports Better Harness with its skills.",
        ),
      ], evidence("zcode-plugin-list", "native-cli-help-with-isolated-smoke")),
    },
  })],
});
