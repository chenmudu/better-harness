# ZCode 插件生命周期（只观察与规划）

## Traceability

- Spec ID: zcode-plugin-lifecycle
- Status: Implemented

## Intent

让 Better Harness 的 `plugin status/plan/verify` 认识 ZCode：读取本地插件与配置证据，给出可复制的原生生命周期步骤，并验证安装结果。生命周期只观察和规划，所有 mutation 步骤都由维护者在 Better Harness 之外显式执行。

## Native Evidence

| Item | Evidence |
| --- | --- |
| CLI | ZCode CLI `0.17.1` |
| Install | `zcode plugins install <plugin>[@marketplace] [-s <scope>]` |
| Update | `zcode plugins update <plugin> [-s <scope>]` |
| Remove | `zcode plugins uninstall <plugin> [-s <scope>] [--keep-data] [--force]` |
| Verify | `zcode plugins list [--json] [--available]` |
| Marketplace | `zcode plugins marketplace add <source> [--scope <scope>] [--sparse <path>]`; source accepts URL, path, or GitHub repo |
| Scopes | `user`（默认）、`project` |
| Isolated smoke | Temporary `HOME`/`USERPROFILE`/`ZCODE_HOME`: local checkout added as marketplace, `better-harness@better-harness` installed as `0.7.0-alpha2` with 2 skills `[enabled]`, disable/enable/update succeeded, `uninstall --force` removed it |

Contract fixture: `test/fixtures/plugin-lifecycle/native-help-contracts.v1.json#hosts.zcode`.

## Surface Contract

| Item | Value | Boundary |
| --- | --- | --- |
| Surface | `zcode/cli` | Only the CLI surface is declared. Desktop plugin settings were not proven to read the same store, so no desktop surface is claimed. |
| Distribution | marketplace | Better Harness ships the native `.zcode-plugin/plugin.json` + `.claude-plugin/marketplace.json`. ZCode prefers `.zcode-plugin` over the `.claude-plugin`/`.codex-plugin` fallbacks. |
| Observation | inventory | Installed records plus user `plugins.dirs` inline plugins collected by the ZCode agent-customize provider. |
| Inventory homes | `--zcode-home` / `~/.zcode`; `zcodeUserHome` / `~` | Both routes bind to `--host-home` during status. |
| Install home binding | none | ZCode CLI resolves `~/.zcode/cli` through `homedir()` and exposes no config-root env override; plans with `--host-home` are blocked instead of guessing. |
| Host executable | `zcode` | If `zcode` is not on `PATH`, plan is blocked with `HOST_EXECUTABLE_NOT_FOUND`; status/verify still read local evidence. |

## Lifecycle Dispositions

| Operation | Disposition | Reason |
| --- | --- | --- |
| install | supported | Marketplace registration and install verified in isolated home. |
| update | supported | `plugins update` verified; session restart still required. |
| remove | supported | `plugins uninstall --force` verified in a non-interactive shell. Without `--force` the CLI refuses; the profile includes it and states that it skips confirmation. |
| verify | supported | `plugins list --json` is the native read-only confirmation. |

## Acceptance Scenarios

- AC-L1（Profile）：ZCode 是 managed host，只有一个 `cli` marketplace surface，scopes 为 `user|project`，observation 为 `inventory`；install/update/remove/verify 都带 native contract evidence；缺少 evidence 时 profile 校验失败。
- AC-L2（Status installed）：本地 inventory 有 Better Harness 时，status 行显示 `installation: installed`、正确的 scope 与 enablement；runtime activation 仍为 unobserved，因此 verify 为 `partial` 而不是伪造 loaded。
- AC-L3（Status absent）：没有匹配记录时为 `not-installed`，并产生 `PLUGIN_NOT_INSTALLED`。
- AC-L4（Status unobserved）：有记录但无法解析安装 scope 时为 `unknown`，并产生 `INSTALL_SCOPE_UNSUPPORTED`，不猜测为已安装或未安装。
- AC-L5（Plan）：install/update/remove 生成 `zcode plugins ...` argv；mutation 步骤标为 external，verification 步骤标为 read-only；未安装时 update 被阻止，remove 为 noop。
- AC-L6（Verify）：`plugin verify --host zcode` 只读本地证据，报告 targets/partial/failed 与 diagnostics。
- AC-L7（Isolation / honesty）：`--host-home` 会隔离 status inventory（`zcodeHome` 与 `zcodeUserHome`）；ZCode 没有可绑定的 native home，因此 plan 明确以 `ISOLATED_HOST_HOME_UNREPRESENTABLE` 阻止，而不是回落到真实 home。未知 surface 报 `UNKNOWN_HOST_SURFACE`。
- AC-L8（Boundaries）：ZCode 不进入 Checkup、Canvas 或报告路由；不发布托管 marketplace；不执行任何 ZCode 命令。

## Non-goals

- 不执行 install/update/uninstall/enable/disable；只生成外部步骤。
- 不声明 Desktop surface、Desktop 插件 UI 路径或跨 CLR/Desktop 的 enablement 合并。
- 不调用 `zcode hooks trust status` 或重算 hook trust digest。
- 不把 `plugins list --available` 的目录结果当作已安装证据。
- 不做托管市场发布或版本托管。

## Test and Review Evidence

```bash
npx vitest run test/plugins/plugin-lifecycle-zcode.test.mjs
npx vitest run test/plugins/host-support.test.mjs test/plugins/host-support-profiles.test.mjs test/plugins/plugin-lifecycle.test.mjs test/plugins/plugin-lifecycle-status-row.test.mjs test/plugins/plugin-lifecycle-target-resolution.test.mjs
node scripts/better-harness.mjs plugin status --host zcode
node scripts/better-harness.mjs plugin plan install --host zcode --surface cli --scope user
node scripts/better-harness.mjs plugin verify --host zcode
```

| AC | Evidence |
| --- | --- |
| AC-L1 | `plugin-lifecycle-zcode.test.mjs` profile assertions; `host-support-profiles.test.mjs` fixture parity |
| AC-L2/L3/L4 | `plugin-lifecycle-zcode.test.mjs` status matrix |
| AC-L5 | `plugin-lifecycle-zcode.test.mjs` argv, effects, blocked/noop cases |
| AC-L6 | `plugin-lifecycle-zcode.test.mjs` verify summary; CLI smoke |
| AC-L7 | `plugin-lifecycle-zcode.test.mjs` host-home isolation and blocked plan; `plugin-lifecycle.test.mjs` isolated route coverage |
| AC-L8 | capability registry tests; no Checkup/Canvas changes |

Observed CLI smoke on this machine:

- `plugin status --host zcode` → one `zcode/cli@user` row, `absent/not-installed`, `PLUGIN_NOT_INSTALLED`.
- `plugin plan install --host zcode --surface cli --scope user` → blocked with `HOST_EXECUTABLE_NOT_FOUND` because `zcode` is not on `PATH`; no commands executed.
- `plugin verify --host zcode` → same read-only row, `failed` verification, no installed artifact.

## Risks and Open Questions

- The `marketplace add` source argument accepts URL/path/GitHub per native help; the isolated smoke used a local checkout path. Network fetch of the GitHub URL was not exercised.
- Non-interactive uninstall requires `--force`; the plan includes it and documents that it bypasses confirmation. Maintainers should review the target before running it.
- ZCode CLI has no config-root environment override, so isolated plan binding is impossible by design. Status inventory isolation still works through `--zcode-home`/`--zcode-user-home`.
- If ZCode later ships a PATH-installable CLI or a desktop plugin store with a distinct contract, the profile needs a new surface and fresh evidence.
