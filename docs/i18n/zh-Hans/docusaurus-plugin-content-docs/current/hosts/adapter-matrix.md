---
id: adapter-matrix
title: 适配矩阵
sidebar_position: 1
---

# 宿主适配矩阵

Better Harness 运行在你现有的编码智能体内。宿主差异只进入一个轻量适配层：
宿主 shell、已配置资产 provider、会话证据适配器和输出模式。规范的产品判断
保持与宿主无关。

## 支持层级

Better Harness 当前声明了十个能力层宿主适配器，其中六个已有验证过的公开
快速开始路径。Pi、Kimi Code、WorkBuddy 与 Grok 以适配器支持展示，因为它们的安装方式和端到端
证据边界与这六个宿主不同。ZCode 以适配器支持展示：只读会话证据、已配置资产、
最小原生安装面和只读 CLI 插件生命周期，但不含报告渲染路由或桌面插件 surface，
且生命周期 plan 需要 `zcode` 在 `PATH` 上。完整能力层事实源仍是
[规范适配器矩阵](https://github.com/QoderAI/better-harness/blob/main/docs/adapters/README.md)。

## 受支持的宿主适配器

| 宿主 | 公开入口 | 定位 | Shell | 会话证据 | 默认输出 |
| --- | --- | --- | --- | --- | --- |
| Qoder | 已验证快速开始 | 一等产品宿主 | `.qoder-plugin/` | Qoder 会话 | Qoder Canvas 报告 |
| Claude Code | 已验证快速开始 | 具备分析能力的源码本地宿主 | `.claude-plugin/` | 匹配当前工作区的本地 Claude 转录（存在时） | 自包含 HTML + Markdown |
| Codex | 已验证快速开始 | 具备分析能力的源码本地宿主 | `.codex-plugin/` | Codex 会话 | 自包含 HTML + Markdown |
| Cursor | 已验证快速开始 | 支持 Canvas 的源码本地宿主 | `.cursor-plugin/` | 工作区匹配的转录、元数据、审计日志和可选原生 Context Usage 快照；部分覆盖保持显式标注 | Cursor Canvas 报告 |
| Qwen Code | 已验证快速开始 | 具备分析能力的源码本地宿主 | `qwen-extension.json` | 匹配当前工作区的本地 Qwen 转录（存在时） | 自包含 HTML + Markdown |
| GitHub Copilot | 已验证快速开始 | 具备分析能力的源码本地宿主 | `.github/plugin/` | 工作区匹配的 Copilot CLI 转录；部分覆盖保持显式标注 | 自包含 HTML + Markdown |
| Pi | 适配器支持 | 具备分析能力的源码本地宿主 | `package.json` 中的 `pi` manifest | 匹配当前工作区的本地 Pi 会话，包含 Oh My Pi (OMP) 会话布局 | 自包含 HTML + Markdown |
| Kimi Code | 适配器支持 | 具备分析能力的源码本地宿主 | `.kimi-plugin/plugin.json` | 匹配工作区的 Kimi wire 转录 | 自包含 HTML + Markdown |
| WorkBuddy | 适配器支持 | 具备分析能力的源码本地宿主 | 无；Skill 使用 WorkBuddy 自有路径 | 匹配工作区的 WorkBuddy JSONL 转录 | 自包含 HTML + Markdown |
| Grok | 适配器支持 | 具备分析能力的源码本地宿主 | 无；Skill 使用 Grok 自有路径 | 匹配工作区的 Grok 会话目录（`updates.jsonl`） | 自包含 HTML + Markdown |
| ZCode | 适配器支持 | 只读会话、已配置资产与 CLI 插件生命周期；无报告路由或桌面插件 surface | `.claude-plugin/`（原生 fallback） | 来自 `~/.zcode/cli/db/db.sqlite` 的只读 SQLite 会话；工作区取自 `session.directory`，排除软删除会话，保留父/任务子代理关联 | 仅会话证据 |

`@qoder-ai/better-harness` npm 包含全部七个插件元数据根目录。生成的 Qoder
运行时 bundle 只包含 Qoder shell。Pi 复用现有 `package.json` 中的安装元数据，
因此不会新增第八个文件系统元数据根目录；非 Qoder 的生成宿主产物保持源码本地。

## 只读插件生命周期

独立 CLI 可以规范化本地 Better Harness 安装证据，同时保留宿主能力差异：

```bash
better-harness plugin status --host all
better-harness plugin verify --host all
better-harness doctor --platform all
```

`plugin plan` 要求显式指定一个宿主，并输出带类型的原生 argv 或手工步骤，
但不会执行。Qoder Desktop 保持内置分发，Codex Desktop 使用手工 UI 步骤；
Cursor 在本机 help 合同过期期间保持安装不可用；Pi 持久化 surface 中缺少原生
证据的操作保持不可用，临时 session surface 的更新/移除不适用；WorkBuddy 返回
`PLUGIN_LIFECYCLE_UNSUPPORTED`。Kimi Code 与 Grok 尚无经验证的原生生命周期
合同，因此生命周期目标会以 `UNKNOWN_HOST` 拒绝它们，其适配器证据仍然可用。
ZCode 声明一个 CLI marketplace surface：install、update、remove 与
`plugins list --json` 验证均为受支持的原生步骤。plan 从不执行；当 `zcode` 不在
`PATH` 上时以 `HOST_EXECUTABLE_NOT_FOUND` 阻止。ZCode CLI 没有配置根环境变量，
因此 plan 无法绑定隔离 host home，会明确以 `ISOLATED_HOST_HOME_UNREPRESENTABLE`
阻止而不是回落真实 home。在 ADR-0002 仍为 proposed 期间，shadow host profile 不替代
规范适配器矩阵。

## 输出模式

- **Qoder Canvas** —— 渲染器负责的 `findings.json`、仅 Canvas 使用的
  `canvas.json` 和 `report.canvas.tsx`。
- **Cursor Canvas** —— 使用 `cursor/canvas`、原生 Context Window 证据和
  IDE actions 渲染同一份完整报告契约。
- **HTML 可视化** —— 面向 Claude Code/Codex/Qwen/Copilot/Pi/Kimi Code/WorkBuddy/Grok 的可移植契约，覆盖
  `findings.json`、`report.md` 和自包含的 `report.html`
  （见[示例报告](pathname:///demo/better-harness-report/)）。
- **纯 Markdown** —— 无视觉版本。

## 适配器支持边界

### Pi {#pi}

Pi 可以通过 `pi install <source>` 安装本仓库，或使用 `pi -e <source>` 加载。
生命周期状态把持久化的用户/项目包设置作为 `cli` inventory surface，把单次
`pi -e` 激活作为独立的 `cli-session` session-only surface；空设置不能证明正在
运行的会话没有加载该包。包发现、已配置资产、工作区匹配的会话证据与可移植
HTML 路由均已实现。在观察到完整交互式报告闭环冒烟验证前，Pi 仍不进入已验证
快速开始集合。

### Oh My Pi (OMP) {#oh-my-pi-omp}

Oh My Pi (OMP) 不是独立的宿主适配器，而是 `pi` 平台能识别的一种会话布局：将
`PI_CODING_AGENT_DIR=~/.omp/agent` 指向 OMP 的 agent 目录即可。OMP 在本仓库里
没有自己的 host id、能力画像、安装 Shell 或生命周期目标。

OMP 以相对 home 目录的工作区路径命名会话目录（`~/src/dotai` → `-src-dotai`），
而不是 pi 的绝对路径 `--<slug>--` 形式，并且在会话头之前先写一条 `title` 记录。
Pi 适配器同时识别两种命名约定并跳过该前置记录，同时保留 pi 的 fail-closed
会话头规则与工作区隔离。OMP 的 `/fork` 转录会复制父会话的全部条目：只有当父
会话也在同一次发现结果中时，这些条目才计入父会话，因此既不会重复计数，也不会
静默丢失。会话证据与可移植 HTML 路由均来自共享的 Pi provider；已配置资产也由 Pi
provider 清点，因为它遵循同一个 `PI_CODING_AGENT_DIR` 覆盖项。

### Kimi Code {#kimi-code}

Kimi Code 通过 `/plugins install <source>` 和 `.kimi-plugin/plugin.json`
manifest 安装本仓库，reload 后使用 `/skill:better-harness`。已配置资产、
工作区匹配的 wire 转录与可移植 HTML 路由均已实现。在观察到完整交互式报告
闭环冒烟验证前，Kimi Code 仍不进入已验证快速开始集合。

### WorkBuddy {#workbuddy}

WorkBuddy 的已配置资产、工作区匹配的会话证据与可移植 HTML 路由均已实现。
本仓库不提供 WorkBuddy 安装 Shell、插件 manifest 或 npm 打包的宿主产物；安装
仍通过 WorkBuddy 自有的 `~/.workbuddy/skills` 或 Marketplace 入口完成。

### Grok {#grok}

Grok 的已配置资产、工作区匹配的会话证据与可移植 HTML 路由均已实现。
本仓库不提供 Grok 安装 Shell 或 npm 打包的宿主产物；安装方式是将 Skill 软链到
`~/.grok/skills/better-harness`（或项目 `.grok/skills`）。在观察到完整交互式
报告闭环冒烟验证前，Grok 仍不进入已验证快速开始集合。

### ZCode {#zcode}

ZCode 支持包含本地只读会话证据、配置资产、最小原生安装面与只读 CLI 插件生命周期。
`session-analysis --platform zcode` 读取单个 SQLite 数据库，优先级为
`--zcode-db` > `<--zcode-home>/cli/db/db.sqlite`
> `~/.zcode/cli/db/db.sqlite`，通过 `node:sqlite` 以只读模式打开并设置
`PRAGMA query_only = ON`。发现阶段排除软删除会话（`time_deleted`），工作区
只从 `session.directory` 判定，并保留 `parent_id`/`task_type` 子代理关联。
一次模型请求保留原生 `logical_request_id@attempt_index` 身份，使重试保持独立。
ZCode 的 `input_tokens` 已包含缓存读取与缓存创建，因此适配器单独报告未缓存
输入，并设置 `cacheAccountingMode: separate-input-lane`，不会重复累加缓存 lane。
原生 origin 不是 `real_user` 的消息，以及带注入来源的 part，都不计入用户轮次。
默认不输出提示词、命令、工具输出和内容，仅在现有本地诊断 include 开关下出现。

已配置资产通过 `scripts/agent-customize/providers/zcode.mjs` 只读清点：用户级
`~/.zcode` 与 `~/.agents`、项目 `.zcode`/`.agents` 根、AGENTS.md、MCP、hooks、
subagents，以及插件记录与贡献。项目配置按 ZCode 的白名单读取；`storage`、
`permission`、`network`、`plugins.dirs` 等用户级字段会被剥离并产生诊断。项目 hooks
只报告 configured/trust-gated，绝不声称已信任；live MCP 状态、运行时 subagents
与同名运行时优先级仍为 unsupported。

最小安装面复用 `.claude-plugin/plugin.json` 与 `.claude-plugin/marketplace.json`。
维护者可执行：

```bash
zcode plugins marketplace add <path-or-repository> --scope user
zcode plugins install better-harness@better-harness --scope user
zcode plugins list --json
```

隔离安装冒烟结果为 `better-harness@better-harness` 版本 `0.7.0-alpha2`，包含两个
Skill 且为 enabled。`plugin status/plan/verify --host zcode` 只观察本地安装、输出
外部原生步骤，且从不执行。ZCode 仍没有报告路由、Canvas、Checkup、Studio、
桌面插件 surface 或公开快速开始声明。

## 能力覆盖

各宿主的能力刻意保持差异：没有真实证据源的宿主不会声称具备某项能力，
不受支持的行为会在读取私有数据或修改文件之前失败。逐能力的覆盖表、
TODO 列表和完成定义维护在仓库
[roadmap](https://github.com/QoderAI/better-harness/blob/main/roadmap.md) 中。

## 事实源

规范矩阵、发现规则和拆分触发条件见
[`docs/adapters/README.md`](https://github.com/QoderAI/better-harness/blob/main/docs/adapters/README.md)。

## 贡献新的宿主

请从[贡献新的 Coding Agent 宿主](./contributing-new-coding-agent)开始。
该指南会分别处理原生 Shell、已配置资产、会话、输出和打包声明，并链接
Qwen Code 与 GitHub Copilot PR 作为复盘示例。
