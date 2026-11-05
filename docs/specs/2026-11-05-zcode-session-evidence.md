# 接入 ZCode 本地会话证据

## Traceability

- Spec ID: zcode-session-evidence
- Status: Implemented

## Intent

Better Harness 现有的 session-analysis 适配器都以文件型转录（JSONL/JSON）为入口；ZCode 0.16.x 把会话保存在单个 SQLite 库中。维护者需要 `session-analysis --platform zcode` 在不写入宿主数据的前提下，读取与当前工作区匹配的 ZCode 会话，并把 turn、step、模型请求、工具调用、压缩和子代理证据交给现有 facts/insights 消费。

首个切片只声明 Session Evidence。ZCode 的安装壳、configured-assets、plugin lifecycle、Checkup 和 Canvas 不在本 spec 的交付范围内，也不因为存在会话适配器而获得能力声明。

## Support Claim

| Slice | Claim | Evidence boundary |
| --- | --- | --- |
| Session Evidence | Available | 只读 `~/.zcode/cli/db/db.sqlite`；按工作区限定会话；turn/step/request/tool/compaction/subagent 证据按本 spec 的 AC 验证 |
| Shell / Install | Unavailable | 不新增 ZCode 安装元数据、插件清单或安装步骤 |
| Configured Assets | Unavailable | 不读取 `~/.zcode/skills`、`AGENTS.md`、`mcp.json` 或 hooks 配置 |
| Plugin Lifecycle | Unavailable | 不新增 lifecycle profile，不接受 `plugin` 子命令的 ZCode 目标 |
| Checkup | Unavailable | 不把 ZCode 加入 Checkup 宿主集合 |
| Canvas | Unavailable | 不新增 ZCode 专用 Canvas 或报告渲染器 |
| Output | Existing generic paths only | 仅当其他工作流选择通用 HTML/Markdown 输出时复用现有契约；不新增 ZCode 专属输出模式 |

## Data Source Contract

### Location and access

- 默认数据库：`~/.zcode/cli/db/db.sqlite`，由 `os.homedir()` 与 `node:path` 组合，不写死分隔符。
- `--zcode-home <dir>` 覆盖默认根；数据库默认位于 `<home>/cli/db/db.sqlite`。
- `--zcode-db <file>` 直接指定数据库文件；优先级高于 home 推导。
- 只读打开：`node:sqlite` 的 `DatabaseSync({ readOnly: true })`，并执行 `PRAGMA query_only = ON`。适配器不得执行 `INSERT`、`UPDATE`、`DELETE`、DDL、`VACUUM` 或迁移。
- `node:sqlite` 不可用时，分析命令以 `zcode-sqlite-unavailable` warning 降级，不崩溃。
- 数据库不存在或不是文件时，`sources` 返回 `exists: false`，并给出 `zcode-database-missing` warning。

### Table semantics

| Concept | Source | Mapping rule |
| --- | --- | --- |
| Session | `session` | `time_deleted is null`；`directory` 是工作区 cwd；`parent_id`/`task_type` 表示子代理 |
| Turn | `turn_usage` | `turn_id`、`started_at`、`completed_at`、`status`、token/cache 聚合 |
| Step | assistant `message` + `part` | `part.data.type` 为 `step-start`/`step-finish`；turnId 来自 `message.data.anchor.turnId`；按 turn 内 `message.sequence` 编号 |
| Model request | `model_usage` | 逻辑身份 `logical_request_id@attempt_index`；每次 attempt 是独立计费观察 |
| Tool | `part(type=tool)` + `tool_usage` | `part.data.callID` 关联调用与结果；`tool_usage` 提供时长、状态、错误、审批状态 |
| Compaction | `part(type=compaction/timeline)` + `session_input(kind=compact)` | `timelineType=context_compaction`；只把真实压缩事件暴露为 compaction |
| Injected message | `message.semantics.origin` + `part.metadata.source` | 只有显式 `real_user` 才算用户消息；其余一律 metadata |
| Model switch | `part(type=timeline, timelineType=model_change)` | `from`/`to` 取 selection label |
| Attachment | `part(type=file)` | mime、字节数、artifact URI；不读取文件内容 |
| Schema version | `schema_migration` | 读取最新 `app_version` 供诊断；缺表不阻断读取 |

### Token semantics

ZCode 的 `input_tokens` **包含** `cache_read_input_tokens` 与 `cache_creation_input_tokens`；本机 13,628 条 `model_usage` 中 `provider_total_tokens = input_tokens + output_tokens` 无例外。适配器必须先把重叠计数拆成互斥车道，再交给现有 usage 契约：

```text
uncachedInputTokens = max(0, input_tokens - cache_read_input_tokens - cache_creation_input_tokens)
promptSideTokens    = uncachedInputTokens + cache_read_input_tokens + cache_creation_input_tokens
totalTokens         = provider_total_tokens ?? computed_total_tokens ?? (promptSideTokens + output_tokens)
```

归一化后的 `model.response.completed` 记录使用：

- `inputTokens = uncachedInputTokens`
- `cacheReadInputTokens`
- `cacheCreationInputTokens`
- `outputTokens`
- `totalTokens = provider_total_tokens`（若与派生值不一致，保留 `totalDerived: true`）
- `cacheAccountingMode = "separate-input-lane"`

缺失计数保持 `null`，不得填 `0`。`reasoning_tokens` 是否包含在 `output_tokens` 内当前不可验证；若存在，保留为 `reasoningOutputTokens` 观察值，不参与 promptSide 或 total 的推断。

## Acceptance Scenarios

- AC-1（Sources）：`sources --platform zcode --workspace <ws>` 返回且只返回一个 root，`kind` 为 `zcode-sqlite`、`role` 为 `session-store`、`path` 为实际数据库路径；数据库缺失时 `exists: false` 且有 `zcode-database-missing` warning；`node:sqlite` 不可用时不崩溃。
- AC-2（Workspace discovery）：只发现 `time_deleted is null` 且 `directory` 被 `classifyWorkspaceCwd` 判为 `DIRECT` 或 `ROOT_CANDIDATE` 的会话；外来工作区、软删除会话和 `--session-id` 之外的会话不进入结果；不使用 SQL `LIKE` 猜测路径。
- AC-3（Session shape）：每个会话至少包含 `sessionId`、`workspace`、`firstSeen`、`lastSeen`、`sourceKinds: ["zcode-sqlite"]`、`sourceRefs`、`workspaceCwds`、`parentSessionId`、`isSubagent`；`firstSeen`/`lastSeen` 由 session 时间与 message/part/turn 时间共同收敛，不能因为标题更新时间而漂移。
- AC-4（User vs injected）：只有 `message.semantics.origin === "real_user"` 的 user 文本产生 `user` 事件并带 `userPrompt: true`；`metadata.source` 存在、`semantics.origin` 非 `real_user`、`part.synthetic === true` 或隐藏的运行时消息只产生 `metadata.injected_message`，不得被 `summarizeEvents` 计入 user/message 计数。
- AC-5（Assistant and tools）：assistant 文本 part 产生 `assistant`；reasoning part 产生 `metadata.reasoning`；`part(type=tool)` 产生 `tool.call` 与 `tool.result`，用 `callID` 关联；`completed`、`error`、`cancelled` 等原生状态映射到 `success`/`hasError`/`lifecyclePhase`；缺失 `tool_usage` 时仍保留 part 证据，但 coverage 为 partial 而不是伪造成功。
- AC-6（Retry and usage）：每条有可用计数的 `model_usage` 产生一次 `model.response.completed`；`responseId = logical_request_id@attempt_index`，同一 `logical_request_id` 的多个 attempt 不被静默合并；`requestId = logical_request_id` 用于分组；没有可用计数的 attempt 不产生全零 usage 记录，而是产生带状态的 metadata 事件和 partial coverage。
- AC-7（Turn and step coordinates）：`turn_usage` 产生 `turn.start`/`turn.end`，按 `started_at` 稳定编号；事件在可观察时携带 `turn`/`step` 坐标；没有 step 标记的 turn 仍可出现，step 数为 0，不能把后续 turn 的 step 错配进来。
- AC-8（Compaction, model switch, attachment）：compaction 事件来自真实 `compaction`/`context_compaction` part 与 `session_input(kind=compact)`；模型切换与附件各自产生结构化事件；事件证据引用包含表名与 row id，能回到原始行。
- AC-9（Privacy）：默认输出不含用户原文、工具 input/output、命令文本或文件内容；只有 `includeUserText`、`includeContent`、`includeCommandText` 才输出对应字段，并统一经过 `privacy-safe-text.mjs` 的清理；fixture 不含真实会话 id、绝对宿主路径或真实内容。
- AC-10（Unknown and malformed）：未知 part type、未知 timeline type、损坏 JSON、缺表或缺列不静默丢弃；产生稳定 warning 与可见 coverage，单个坏行不能让整场会话读取失败。
- AC-11（Read-only）：用只读文件权限的临时数据库运行完整 `discoverSessions` + `readSession`，读取成功且数据库内容/数据版本不变；适配器不创建新的表、索引、迁移或宿主写入。
- AC-12（CLI）：`sessions --platform zcode --workspace <ws> --limit 3` 输出有界 JSON；`show --session-id <id>` 返回归一化事件；`facts --platform zcode --workspace <ws> --limit 3` 完成并输出有界 packet，代表 fixture 至少产生 1 个任务候选，证据不足时给出显式 warning 而不是伪造候选。
- AC-13（Registry and docs）：`SUPPORTED_SESSION_PLATFORMS` 包含 `zcode`；`--platform zcode` 的 help 可发现 `--zcode-home` 与 `--zcode-db`；`HOST_DESCRIPTORS` 中 ZCode 只声明 `SESSION_ANALYSIS`，`sessionScopeTokens` 为 `[".zcode", "zcode"]`；适配器矩阵把 ZCode 标为 session-only 且不进入 Quickstart、Checkup 或 lifecycle。

## Non-goals

- 不新增 ZCode 安装壳、插件清单、Skill/Agent/配置资产读取或 lifecycle profile。
- 不实现 ZCode 专用 Canvas、HTML 模板、report-quality 规则或 Checkup 路由。
- 不解析请求重放日志 `~/.zcode/cli/debug/model-io-*.jsonl`；请求上下文与完整 prompt 不在首个切片内。
- 不修改 `scripts/session-analysis/platforms/dsh.mjs`；DSH v4 兼容是独立任务。
- 不修改 MCC（`my-context-cockpit`）或把 MCC 的 read model 作为运行时依赖。
- 不引入第三方 SQLite 依赖；只使用 Node 内置 `node:sqlite`。
- 不推断 ZCode 未持久化的字段，不把缺失计数、状态或覆盖率补成 0/full。
- 不为未知未来版本写兼容层；只按当前已验证的 0.16.x 表结构读取，并通过 warning 暴露漂移。

## Plan and Tasks

1. **Spec checkpoint（本文件）**：确认 Support Claim、AC 和 usage 口径后再进入实现。
2. **新增 `scripts/session-analysis/platforms/zcode.mjs`**：
   - `ZcodeSessionAnalyzer extends SessionAnalyzer`，`analyze()` 使用 `runProviderAnalysis(this, options, { platform: "zcode", adapterVersion: "zcode-v1" })`。
   - `resolveScope`：解析 `workspace`、`zcodeHome`、`zcodeDb`、`since/until`、`sessionId`、`_workspaceMatchScope`；`zcodeDb` 默认 `<home>/cli/db/db.sqlite`。
   - `discoverSourceRoots`：单个 root，`kind: "zcode-sqlite"`、`role: "session-store"`、`workspaceScoped: true`、`coverage: "primary"`、`exists` 反映数据库文件；缺失时记录 warning。
   - `discoverSessions`：查询 `session` 非删除行，读取 `id/directory/title/time_created/time_updated/parent_id/task_type`，在 JS 内用 `classifyWorkspaceCwd` 过滤；聚合 message/part/turn 的最早/最晚时间；把宿主 epoch 毫秒统一转成 ISO 8601；构造 `sourceRefs`、`workspaceCwds`、`isSubagent`、`parentSessionId`。
   - `readSession`：只按 `session_id = ?` 查询 `message`、`part`、`turn_usage`、`model_usage`、`tool_usage`、`session_input`；任何表缺失时用 `hasTable` 降级并记录 warning；不跨会话扫描。
   - 事件构造：`user`、`assistant`、`metadata.reasoning`、`metadata.injected_message`、`model.response.completed`、`metadata.model_request`、`tool.call`、`tool.result`、`turn.start`、`turn.end`、`compaction.summary`、`model.switch`、`attachment`、`metadata.session`、`metadata.zcode_part`。
   - 结构化证据：`sourceRef` 使用 `{ kind: "zcode-sqlite", role: "session-store", path, sessionId, table, rowId }`；`evidenceRef` 使用 `{ kind: "zcode-sqlite", path, line: null, seq, type, table, rowId }`。
   - 隐私：默认只给字符数、字节数、toolName、状态、时长；文本字段仅在对应 include 选项下输出并经 `sanitizePrivateReviewText`/`privacySafeUserInputText` 清理。
   - 稳定性：事件按 `time`、来源优先级、row id 排序；同一输入重复读取产生相同 `seq` 与事件顺序。
3. **注册与 help**：
   - `scripts/session-analysis/analyzer.mjs`：在 `PLATFORM_MODULES` 中加入字面量惰性 import `./platforms/zcode.mjs` 与 `ZcodeSessionAnalyzer`。
   - 同一个 help 文本加入 `--zcode-home <dir>` 与 `--zcode-db <file>` 说明；默认平台保持 `qoder`。
   - `scripts/host-support/index.mjs`：加入 ZCode descriptor，仅 `HOST_CAPABILITIES.SESSION_ANALYSIS`，不加入 Checkup。
4. **文档**：
   - `docs/adapters/README.md`：矩阵增加 ZCode 行，定位 “Partial adapter / session evidence only”，写明单 SQLite、只读、无 lifecycle、无 Quickstart。
   - `docs/docs/hosts/adapter-matrix.md`：同步宿主表与支持层级摘要。
   - `docs/i18n/zh-Hans/docusaurus-plugin-content-docs/current/hosts/adapter-matrix.md`：若保持现有孪生结构，同步 ZCode 行与摘要；不新增未翻译的公开 claim。
   - 更新 `docs/adapters/contributing-new-coding-agent.md` 不需要改动；本 spec 按该指南的 session-only 路径执行。
5. **测试**：
   - 新增 `test/sessions/session-analysis-zcode.test.mjs`，用 `mkdtemp` + `node:sqlite` 建最小数据库；fixture 使用匿名工作区路径与会话 id。
   - 覆盖 AC-1 至 AC-13；每个 AC 至少一个行为断言，不按源码正则断言。
   - 更新 `test/sessions/session-analysis-providers.test.mjs` 的 registry/help 断言。
   - 如 host-support catalog 测试需要显式宿主清单，更新 `test/plugins/host-support.test.mjs`；优先让通用循环覆盖，避免复制宿主清单。
6. **验证**：
   - 聚焦测试、全量 `npm test`、文档链接图检查。
   - 真实库 smoke：`sources`、`sessions --limit 3`、`facts --limit 3`，工作区使用 `D:\project\github`。
   - 确认只读：对真实库只执行 SELECT/PRAGMA；不对 `~/.zcode/cli/db/db.sqlite` 发起写操作。

## Test and Review Evidence

执行命令与结果：

```bash
npx vitest run test/sessions/session-analysis-zcode.test.mjs
# 9 passed

npx vitest run test/sessions test/plugins/host-support.test.mjs test/governance/scripts-refactor-contract.test.mjs
# 30 files passed, 487 passed, 1 skipped

npm test
# 119 files passed, 1 failed, 1 skipped; 1789 passed, 1 failed, 8 skipped
# 唯一失败为 test/agents/agent-customize-dsh.test.mjs 的既存 DSH 授权边界用例，
# 不涉及本 spec 修改的文件，单独复跑仍失败（见下方风险与未决项）
```

真实库 smoke（工作区 `D:\project\github`）：

```text
sources  -> 1 root, kind=zcode-sqlite, exists=true
sessions -> 3 sessions bounded; 主会话与 2 个子代理会话，parentSessionId 正确
facts    -> kind=session-core-facts, candidates=3
```

帮助契约：

- `node scripts/session-analysis.mjs --help` 与 `better-harness session-analysis --help` 均包含 `--zcode-home`、`--zcode-db`。
- `test/fixtures/scripts-refactor-contract/{root-help,session-help}.txt` 与
  `commands`/`schema` 的冻结 sha256 已按 ZCode 描述变化更新；`commands --json`
  的完整差异仅限 session-analysis 描述新增 “ZCode”。

AC 与证据映射：

| AC | 预期证据 |
| --- | --- |
| AC-1 | `sources` JSON + 缺失库/缺 SQLite 的 warning 断言 |
| AC-2 | 工作区内/外来/软删除/`--session-id` 四组 fixture |
| AC-3 | `sessions` 返回字段与时间范围的直接断言 |
| AC-4 | 注入消息 fixture 不出现在 `user`/message 计数中 |
| AC-5 | 成功、失败、取消三种 tool fixture；callID 关联断言 |
| AC-6 | 同一 `logical_request_id` 两个 attempt；usage 车道与 `totalTokens` 断言 |
| AC-7 | 有/无 step 标记的 turn；turn 编号与 step 坐标断言 |
| AC-8 | compaction/model switch/attachment 事件与 row id 断言 |
| AC-9 | 默认输出不含原文；include 选项才出现且已脱敏 |
| AC-10 | 未知 part、坏 JSON、缺表 fixture 产生 warning 且不崩溃 |
| AC-11 | 只读数据库上完整读取成功；数据版本/内容不变 |
| AC-12 | `sources`/`sessions`/`facts` CLI 输出断言；facts 至少 1 个候选且不含工具输出/命令 |
| AC-13 | registry、help、host descriptor、矩阵行断言；冻结 help/schema 基线已按唯一预期差异更新 |

风险与未决项：

- `reasoning_tokens` 与 `output_tokens` 的包含关系在当前本机数据中不可验证；首版只保留观察值，不用它推导总量。
- 真实库可能是 WAL 模式；只读打开在缺少 `-shm` 或遇到独占锁时可能失败。适配器必须降级为 warning，不能回退到可写连接。
- 全量 session 扫描依赖 `session` 表规模；本机 333 行可接受。`readSession` 仍必须只查单个 session，禁止把整库事件装入内存。
- Windows 路径大小写与分隔符由 `classifyWorkspaceCwd`/`node:path` 处理；测试同时覆盖 Windows 与 POSIX 形状的 workspace 字符串。
- `node:sqlite` 是 Node 内置实验接口，运行时可能打印 ExperimentalWarning；不影响 stdout 的 JSON 契约。
- 当前 `sourceEventSeqs` 相关问题属于 MCC 的 DSH 适配器（已另行报告），不在本 spec 的修改范围。
- 全量 `npm test` 中 `test/agents/agent-customize-dsh.test.mjs` 的
  “DSH user opt-in and explicit external roots obey distinct authorization boundaries”
  期望 `custom-skill.scope === "other"`，实际为 `"user"`。该用例单独复跑仍失败；
  `scripts/agent-customize/providers/dsh.mjs` 与该测试文件均不在本改动内
  （`git diff` 为空），按既存/环境相关问题单独报告，未在本切片修复。

## Review Checkpoint

本 spec 完成后暂停实现，等待维护者确认 Support Claim、AC 编号、retry/usage 口径和文档定位；确认后再进入 Plan and Tasks 第 2 步。
