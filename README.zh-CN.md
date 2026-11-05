<h1 align="center">Better Harness（分叉）</h1>

<p align="center">
  <a href="README.md">English</a> · 简体中文
</p>

本仓库是 [QoderAI/better-harness](https://github.com/QoderAI/better-harness) 的分叉，
由 chenmudu 独立维护。原始作品版权归 Qoder 所有（Copyright (c) 2026 Qoder），
采用 [MIT 许可证](LICENSE)。

## 本分叉新增

- **ZCode 会话证据**：只读的 `zcode-v1` SQLite 适配器。
- **ZCode 配置资产**：用户级与项目级 `.zcode`、`.agents`、插件、MCP、hooks；
  不输出 secret 和完整 hook 命令。
- **ZCode 安装**：原生 `.zcode-plugin/plugin.json` + `.claude-plugin/marketplace.json`。
- **ZCode 生命周期**：`plugin status/plan/verify` 只读；计划不会执行宿主命令。

在 ZCode 中安装本分叉：

```bash
zcode plugins marketplace add <path-to-checkout>/marketplace.json --scope user
zcode plugins install better-harness@better-harness --scope user
```

## 其他

其他宿主与能力与上游一致。请使用
[上游 README](https://github.com/QoderAI/better-harness#readme)，并把 marketplace
源指向本仓库。交互式 Inspector 示例见
[上游项目](https://qoderai.github.io/better-harness/inspector)。

## 许可证

MIT。原始作品版权归 Qoder 所有（Copyright (c) 2026 Qoder）。本仓库由 chenmudu
独立维护，并非 Qoder 官方发行版。
