# 接入 ZCode 配置资产（只读）

## Traceability

- Spec ID: zcode-configured-assets
- Status: Implemented

## Intent

ZCode 的 Session Evidence 已由 [2026-11-05-zcode-session-evidence.md](2026-11-05-zcode-session-evidence.md) 交付；本 spec 覆盖下一片：把 ZCode 的 Agent Customize 资产纳入 Better Harness 的只读 inventory。

范围包括 user 级与 **项目内 `.zcode`** 两套资产面：AGENTS.md、skills、commands、subagents、MCP、hooks、plugins。实现只读文件，不启动 ZCode、不调用宿主写操作、不做 plugin lifecycle 与 install shell。

项目内 `.zcode` 不是“用户配置的附注”，而是本 spec 的一等资产面：项目可以声明自己的 skills/commands/subagents、MCP、hooks 和插件启用状态，并且有一套与 user 级不同的优先级、剥离规则和可执行性边界。

## Support Claim

| Slice | Claim | Evidence boundary |
| --- | --- | --- |
| Configured Assets | Available（只读、文件型） | 只读取本 spec 列出的权威文件；输出经脱敏；同名冲突只标注不裁决 |
| Session Evidence | Available | 由既有 ZCode session spec 覆盖，本 spec 不改变其 claim |
| Plugin Lifecycle | Available（status/plan/verify 只读） | 见 [2026-11-05-zcode-plugin-lifecycle.md](2026-11-05-zcode-plugin-lifecycle.md)；BH 只观察和规划，不执行 ZCode 命令 |
| Hook Trust Decision | Unavailable | 固定报告 configured/enabled/trust-gated；不调用 `zcode hooks trust status`，不声称 `trusted` |
| Shell / Install | Available（最小原生 marketplace 安装） | 原生 `.zcode-plugin/plugin.json` + ZCode 专用根 `marketplace.json`；`.claude-plugin/marketplace.json` 保持给 Claude；在隔离 HOME 中验证，见安装指南 |
| Checkup | Unavailable | 不把 ZCode 加入 Checkup 宿主集合 |
| Checkup | Unavailable | 不把 ZCode 加入 Checkup 宿主集合 |
| Canvas / Output | Existing generic paths only | 复用现有 inventory/manage 输出；不新增 ZCode 专属渲染 |

## Data Source Contract

### 1. 根与作用域

| 概念 | 路径 | 说明 |
| --- | --- | --- |
| ZCode home | `--zcode-home`，默认 `~/.zcode` | 只覆盖运行时数据根，不改变 ZCode 对 OS home 的使用 |
| 用户资产根 | `dirname(zcodeHome)` 下的 `.agents` | 与 ZCode 的 `homedir()` 行为对齐；测试可用 `zcodeUserHome` 显式指定 |
| Storage root | 用户配置 `storage.dir` 优先，否则 `zcodeHome` | project 配置不能设置 `storage.dir`；`~` 需展开 |
| Workspace | `--workspace`，默认 cwd | 用 `node:path` 规范化；不假设 `/tmp` 或 POSIX 分隔符 |

ZCode 运行时同时使用两个 home 概念：`~/.zcode`（原生资产）与 `~/.agents`（兼容资产）。BH 必须分别建模，不能把 `~/.agents` 推导成 `.zcode` 的子目录。

### 2. 资产面总表

| 资产 | User 权威位置 | Project 权威位置 | 合并/冲突规则 |
| --- | --- | --- | --- |
| AGENTS.md | `~/.zcode/AGENTS.md` | cwd 向上**最近一个** `AGENTS.md`，止于 worktree root | user 在前、workspace 在后；每个来源 100 KiB；只取一个 project 文件，不逐级合并 |
| Skills | `~/.zcode/skills`、`~/.agents/skills` | 每级 `<dir>/.zcode/skills`、`<dir>/.agents/skills`（cwd → worktree root） | 同一级 `.zcode` 先于 `.agents`；按**路径**去重，同名可并存；先发现者被 `Skill` 工具优先解析 |
| Commands | `~/.zcode/commands`、`~/.agents/commands` | 每级 `<dir>/.zcode/commands`、`<dir>/.agents/commands`（cwd → worktree root） | 同一级 `.zcode` 先于 `.agents`；同名先到先赢（user 胜、cwd 胜）；不读 `.claude/commands` |
| Subagents | `<storageRoot>/agents`（默认 `~/.zcode/agents`） | `<ws>/.zcode/agents` | user 先、project 后；**没有** `.agents/agents` 兼容根；project `permissionMode` 被剥离 |
| MCP | `<zcodeHome>/cli/config.json` 的 `mcp.servers` | 每级 `zcode.json` / `.zcode/config.json` 的 `mcp.servers` | CLI 路径 project 先、user 后 → user 覆盖 project；桌面路径另行走 workspace→user，结果未做运行时对照 |
| Hooks | `<zcodeHome>/cli/config.json` 的 `hooks` | 每级 `zcode.json` / `.zcode/config.json` 的 `hooks` | user hooks 直接执行；project hooks 只进 trust 候选，未信任时不执行 |
| Plugins | `<storageRoot>/cli/plugins/installed_plugins.json` + `known_marketplaces.json` + manifest | project 只能声明 `plugins.enabledPlugins` / `options` | 只读清单；不实现安装/更新/卸载 |

### 3. 项目内 `.zcode` 一等资产面

#### 3.1 发现顺序

- 从 workspace 向上直到含 `.git` 的目录，得到 cwd → worktree root 的目录链；配置加载时反转成 **root → cwd**。
- 每个目录依次尝试 `zcode.json`、`.zcode/config.json`。
- `--project-config <path>`（若提供）作为显式配置追加在自动发现之后，优先级最高。
- 同一真实路径只计一次；去重不得改变剩余条目的顺序。
- 配置合并优先级：system → user → project（root → cwd）→ env → CLI。

**注意**：配置文件的合并顺序（root→cwd）与 skills/commands 根的扫描顺序（cwd→root，先到先赢）方向相反，实现不得复用同一个目录列表。

#### 3.2 项目配置允许的字段

项目配置按 `ZCodeConfigFileSchema.pick({ mcp, hooks, skill, command })`、`plugins.enabledPlugins/options` 和绝对路径 `skills` map 解析，其余字段 `.strip()`：

- 允许：`mcp`、`hooks`、`skill`、`command`、`plugins.enabledPlugins`、`plugins.options`、`skills`（仅绝对路径键）。
- 必须剥离：`modelStream`、`permission`、`storage`、`network`、`features`、`memory`、`logging`、`ui`、`toolConcurrency`、`modelAnomalyGuard`、`plugins.dirs`、`$schema`。
- 项目 `plugins.dirs` 即使写入也不生效；inventory 必须产生诊断，不得把它当插件来源。
- 项目 hooks 从可执行配置中移除，只作为 trust 候选；inventory 必须标记 `project hook is trust-gated`，不能显示为已生效。

#### 3.3 项目目录内容

| 路径 | 运行时是否读取 | inventory 处理 |
| --- | --- | --- |
| `<ws>/.zcode/skills/**/SKILL.md` | 是 | 作为 project skills |
| `<ws>/.zcode/commands/**/*.md` | 是 | 作为 project commands |
| `<ws>/.zcode/agents/*.md` | 是 | 作为 project subagents |
| `<ws>/.zcode/config.json` | 是 | 解析允许的配置子集 |
| `<ws>/zcode.json` | 是 | 同上；与 `.zcode/config.json` 同目录并存时都加载 |
| `<ws>/.zcode/mcp.json`、`<ws>/.zcode/hooks.json` | 否 | 不读取、不展示 |
| `<ws>/.zcode/plugins/` | 否 | 不作为插件来源 |

#### 3.4 兼容 `.agents` 资产

- `<ws>/.agents/skills`、`<ws>/.agents/commands`：运行时读取；同一级 `.zcode` 先扫描。
- `<ws>/.agents/mcp.json`：仅在对应 scope 的 `.zcode` 没有任何 MCP server 时作为 fallback。
- `<ws>/.agents/agents`：**不存在**兼容语义，不得读取。
- `~/.zcode/mcp.json`、`~/.zcode/hooks.json`、`~/.zcode/backup*`：无 loader 读取，必须排除。

### 4. 用户级细节

- AGENTS.md：`~/.zcode/AGENTS.md`，symlink 正常跟随；只有 `priorityFiles` 包含 `AGENTS.md` 时才进入上下文。
- Skills：SKILL.md 扫描 root + 一层子目录；有 frontmatter 时 `name`/`description` 必填、description ≤1024；未知键导致 `safeToAutoLoad=false`；无 frontmatter 时 name 取目录名。
- Commands：`*.md`，递归最多 12 层；子目录变成 `:` 命名空间；名称匹配 `^[a-z0-9][a-z0-9_:-]{0,63}$`；frontmatter 已知键 `allowed-tools`、`argument-hint`、`description`、`disable-noninteractive`、`model`、`skills`。
- Subagents：markdown + YAML；`name`、`description` 必填；可选 `model`、`tools`、`disallowedTools`、`skills`、`permissionMode`、`maxTurns`、`background`、`injectAgentsMd`、`mcpServers`；user agent 可被 `disabledAgentIds` 禁用。
- MCP：`stdio`（command/args/cwd/env）、`http`/`sse`（url/headers/oauth）；兼容 `environment`、`http_headers`、`remote`、`enable`。
- Hooks：7 个事件 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`Stop`；类型 `process`/`command`；单 hook 与来源级 `enabled:false` 都必须如实反映。
- Plugins：manifest 搜索 `.zcode-plugin`、`.claude-plugin`、`.codex-plugin`、`.cursor-plugin`；组件 `agents`/`commands`/`skills`/`hooks`/`mcpServers`；项目只能启用或配置 options，不能指定 `dirs`。

### 5. 隐私与安全

默认输出不得包含：

- `mcp.servers[*].env` 的值、`.headers` 的值、`oauth.clientSecret`、URL 的 userinfo 与 query。
- hook `command` 的完整文本与 `args`；只保留可执行文件 basename 与结构化元数据。
- `plugins.options[*]` 的值、plugin `userConfig[*]` 的敏感值。
- `provider_config.json`、`credentials.json`、`.claude/settings.json` 的任何值；如需证明存在，只给键名。

MCP env 只输出键名；直接看起来像 secret 的键（token/secret/password/credential/api key）额外标记 `directSecretEnvKeys`。URL 去掉凭据与 query。

### 6. 不支持 / 未知项

以下项必须在 `unsupported` 或诊断中显式出现，不得伪造：

- MCP live status（connected/error/tool count）、OAuth pending 状态。
- hooks trust 判定（`trusted_persistent` / `pending_trust`）与 digest 计算；本片不调用 `zcode hooks trust status`。
- subagent runtime 快照（内置回退、最终模型选择）。
- 远端 workspace 资产。
- skills/commands/MCP 同名冲突的最终运行时胜负（桌面与 CLI 顺序不同）。
- plugin 的 effective enabled 链（只读记录 + 显式启用标记）。

## Acceptance Scenarios

- AC-1（Inventory identity）：`better-harness agent-customize inventory --provider zcode --workspace <ws>` 返回 `provider: "zcode"`、`zcodeHome`、`zcodeUserHome`、`workspace`、`tabs`、`plugins`、`manage`、`diagnostics`、`unsupported`；`--zcode-home` 覆盖生效且不影响 `zcodeUserHome` 的独立推导。
- AC-2（Project `.zcode` discovery）：在临时 worktree 的 root、中间目录、cwd 三层放置 `zcode.json` 或 `.zcode/config.json`，断言加载顺序为 root→cwd、同目录 `zcode.json` 先于 `.zcode/config.json`、显式 `projectConfigPath` 最后；重复路径只出现一次。
- AC-3（Project config subset）：项目配置写入 `storage`、`permission`、`network`、`plugins.dirs`、`toolConcurrency` 时，inventory 的 effective 配置不包含这些字段并产生诊断；`mcp`、`hooks`、`skill`、`command`、`plugins.enabledPlugins/options`、绝对路径 `skills` 被接受。
- AC-4（Project skills）：`<ws>/.zcode/skills` 与 `<ws>/.agents/skills` 同时存在时都进入 inventory，`.zcode` 条目的扫描顺序在前；同名不同路径产生 `conflict` 标记而不是静默去重；坏 frontmatter 产生诊断且不丢条目。
- AC-5（Project commands）：`<ws>/.zcode/commands` 与 `<ws>/.agents/commands` 都被收集；子目录命名空间正确；同名冲突标记 `conflict`；非法名称产生诊断；`.claude/commands` 不出现。
- AC-6（Project subagents）：`<ws>/.zcode/agents/*.md` 被收集；`<ws>/.agents/agents` 不被读取；project agent 的 `permissionMode` 不生效并以 `restricted` 字段表达；缺少 name/description 产生诊断。
- AC-7（AGENTS.md）：user 与 workspace 各产生一条 rule；workspace 只取最近一个文件，嵌套目录中的其他 `AGENTS.md` 不出现；超过 100 KiB 标记截断；symlink 指向的文件被正常读取。
- AC-8（MCP）：user `cli/config.json#mcp.servers`、project 各级 `mcp.servers`、`.agents/mcp.json` fallback 分别产生正确 `scope` 与来源；`.zcode` 有 server 时 `.agents` fallback 不出现；`~/.zcode/mcp.json` 不出现；env 只输出键名，headers/clientSecret/URL query 不输出。
- AC-9（Hooks）：user 与 project 的 hooks 都出现在 inventory；project hooks 标记为 trust-gated、不可声称已信任；`enabled:false` 的单 hook 与来源级关闭如实反映；完整 command 文本默认不输出。本片不调用宿主 CLI 的 trust 查询，只报告文件配置。
- AC-10（Dead files）：`~/.zcode/mcp.json`、`~/.zcode/hooks.json`、`~/.zcode/backup*`、`<ws>/.zcode/mcp.json`、`<ws>/.zcode/hooks.json` 即使包含合法形状，也不进入任何 collection。
- AC-11（Plugins）：`installed_plugins.json`、用户级 `plugins.dirs` 内联插件与 manifest 产生 plugin 记录，包含 id/name/version/enabled/rootPath、`installMatch` 与组件计数；同一 realpath 来源合并；plugin 贡献的 skills/commands/agents/hooks/mcp 归组到该 plugin；inventory 本身不执行安装/更新/卸载。
- AC-12（Privacy）：默认 JSON 不含 secret 值、hook 完整命令、plugin options 值、URL query；fixture 使用匿名路径与会话 id。
- AC-13（Unsupported）：MCP live status、hook trust、subagent runtime snapshot、远端 workspace 在 `unsupported` 中出现；`diagnostics` 不把它们伪装成成功。
- AC-14（Malformed / drift）：损坏 JSON、未知 frontmatter 键、缺目录、缺 manifest 字段都产生稳定诊断，单个坏资产不影响其余 collection。
- AC-15（Registry / docs / CLI）：`HOST_DESCRIPTORS` 中 ZCode 增加 `AGENT_CUSTOMIZE`；`agent-customize --help` 出现 `--zcode-home`；适配器矩阵与 `docs/adapters/README.md` 更新为 session + configured-assets + plugin lifecycle + 最小安装，且仍不声明 Checkup、Canvas、托管市场发布。

## Non-goals

- inventory 不启动 ZCode，不调用 `zcode hooks trust grant/revoke`、`plugins install/uninstall`、`mcp/probe`。
- inventory 不执行 plugin marketplace 安装、更新、卸载或启用链；这些只作为外部步骤出现在 [lifecycle spec](2026-11-05-zcode-plugin-lifecycle.md) 的计划里。
- 不把项目 hook 报告为 trusted；trust 判定留给宿主，不在 BH 中重算 digest 或读取宿主 trust store。
- 不把项目 `plugins.dirs` 当插件来源；只产生剥离诊断。
- 不读取 `provider_config.json`、`credentials.json`、`.claude/settings.json` 的值。
- 不推断 ZCode 未持久化的 effective 状态（trust、live MCP、runtime subagent）。
- 不修改 session 适配器与 `scripts/session-analysis/platforms/dsh.mjs`。
- 不为未知未来版本的配置字段写兼容层；未知字段保留并产生诊断。

## Plan and Tasks

1. **Spec checkpoint（本文件）**：确认项目 `.zcode` 的表面、优先级与两个未决项后再实现。
2. **新增 `scripts/agent-customize/providers/zcode.mjs`**：
   - `collectZcodeCustomizeInventory(options)`，返回与现有 provider 相同的 `{ provider, zcodeHome, zcodeUserHome, workspace, tabs, plugins, manage, diagnostics, unsupported }`。
   - 复用 `core/items.mjs` 的 `collectSkillFiles`、`collectMarkdownItems`、`collectRuleSources`、`collectMcpFromValue`、`buildManageCollections` 等；hooks 与项目配置需要 ZCode 专用解析。
   - 配置发现实现 root→cwd；skills/commands 根实现 cwd→root；两者不得共用同一顺序。
   - 项目配置按 3.2 的白名单读取并产生剥离诊断。
3. **注册与元数据**：
   - `scripts/agent-customize/providers/index.mjs` 增加 `zcode` 惰性 collector。
   - `scripts/host-support/index.mjs` 的 ZCode descriptor 增加 `HOST_CAPABILITIES.AGENT_CUSTOMIZE`，仍不加入 Checkup。
   - CLI help 由 `hostHomeOptionKeys` 自动带出 `--zcode-home`。
4. **文档**：
   - `docs/adapters/README.md`、`docs/docs/hosts/adapter-matrix.md` 及 zh-Hans 孪生：ZCode 从 session-only 更新为 session + configured-assets，并写明项目 `.zcode` 与 trust/lifecycle 边界。
5. **测试**：
   - 新增 `test/agents/agent-customize-zcode.test.mjs`，用 `mkdtemp` 构造 user home、`.agents` 兼容根、多级 project 目录与 plugins。
   - 覆盖 AC-1 至 AC-15；每个 AC 至少一个行为断言，不断言源码文本。
   - 更新 host-support / providers registry 断言。
6. **验证**：
   - 聚焦测试、全量 `npm test`、doc-link-graph。
   - 真实环境只读 smoke：`agent-customize inventory --provider zcode --workspace D:\project\github`；确认不读取死文件、不出现 secret。

## Test and Review Evidence

实际执行：

```bash
npx vitest run test/agents/agent-customize-zcode.test.mjs      # 15 passed
npx vitest run test/plugins/host-support.test.mjs              # 6 passed
node scripts/better-harness.mjs agent-customize inventory --provider zcode --workspace D:\project\github
node scripts/better-harness.mjs agent-customize manage --provider zcode --workspace D:\project\github --tab skills
npx vitest run test/skills-docs/doc-link-graph.test.mjs
npm test
```

真实环境只读 smoke（2026-11-05）：`provider: zcode`，plugins 2、MCP 3、skills 39、subagents 0、rules 1、commands 0、hooks 5；`~/.zcode/cli/db/db.sqlite` SHA-256 前后均为 `19dbedec4ade601d528fe6476202a2a689352da3a04c685986445e364f4d517f`。

AC 与证据映射：

| AC | Evidence |
| --- | --- |
| AC-1 | `ZCode inventory resolves homes...`、`ZCode honors ZCODE_HOME...`、`ZCode is registered...` |
| AC-2 | `ZCode discovers project configs root-to-cwd...` |
| AC-3 | 同上（允许/剥离字段与诊断） |
| AC-4/5 | `ZCode project skills and commands...`；symlink 去重测试 |
| AC-6 | `ZCode project subagents use .zcode/agents only...` |
| AC-7 | `ZCode loads only the nearest workspace AGENTS.md...` |
| AC-8 | `ZCode MCP inventory merges config sources...` |
| AC-9 | `ZCode hooks keep user, project, and plugin scopes...` |
| AC-10 | `ZCode inventory reports unsupported surfaces and survives malformed inputs`、dead-file fixtures |
| AC-11 | `ZCode plugin records expose enabled state...`、`ZCode inventories inline plugins.dirs...` |
| AC-12 | MCP/hook/plugin 测试中的脱敏断言与真实 JSON 扫描 |
| AC-13 | `unsupported` 列表断言 |
| AC-14 | 坏 JSON/frontmatter 诊断断言 |
| AC-15 | registry/CLI help 测试；本 spec 与 lifecycle spec、矩阵、安装指南 |

## Risks and Open Questions

- 决策：hook trust 只报告 `configured/enabled/trust-gated`，不调用宿主 CLI；trust 判定保留在 `unsupported`。
- 决策：plugin 首片包含已安装记录、用户级 `plugins.dirs` 内联源与贡献资产归组；项目级 `plugins.dirs` 只产生剥离诊断。
- CLI 与桌面端在 commands/MCP 同名冲突上的顺序相反；本机没有运行时对照，inventory 只能声明 CLI runtime 模型并标记 `conflict`。
- 若用户配置了自定义 `storage.dir`，subagents/plugins 根随之变化；session 适配器目前仍按 `<home>/cli/db/db.sqlite` 读取，两个 slice 的根解析需要保持一致，但不并要求在同一 PR 内修复 session 侧。
- 真实环境中 `~/.agents` 可能只有 `.skill-lock.json`，`~/.zcode/commands` 不存在；fixture 必须同时覆盖“存在但为空”和“不存在”。

## Review Checkpoint

2026-11-05 实现完成。项目 `.zcode` 资产表面、hook trust 边界与 plugin 深度已按本 spec 决策落实；lifecycle 与安装面由 [2026-11-05-zcode-plugin-lifecycle.md](2026-11-05-zcode-plugin-lifecycle.md) 覆盖。
