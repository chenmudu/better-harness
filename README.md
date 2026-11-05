<p align="center">
  <img src="assets/logo.svg" alt="Better Harness logo" width="56" height="56">
</p>

<h1 align="center">Better Harness (fork)</h1>

<p align="center">
  English · <a href="README.zh-CN.md">简体中文</a>
</p>

Fork of [QoderAI/better-harness](https://github.com/QoderAI/better-harness),
maintained independently by chenmudu. Original work Copyright (c) 2026 Qoder,
under the [MIT License](LICENSE).

## What this fork adds

- **ZCode session evidence**: read-only `zcode-v1` SQLite adapter.
- **ZCode configured assets**: user and project `.zcode`, `.agents`, plugins,
  MCP, hooks, with secrets and full hook commands removed.
- **ZCode install**: native `.zcode-plugin/plugin.json` plus
  `.claude-plugin/marketplace.json`.
- **ZCode lifecycle**: `plugin status/plan/verify`, read-only; plans never
  execute host commands.

Install this fork for ZCode:

```bash
zcode plugins marketplace add https://github.com/chenmudu/better-harness.git --scope user
zcode plugins install better-harness@better-harness --scope user
```

## Everything else

Other hosts and capabilities are unchanged from upstream. Use the
[upstream README](https://github.com/QoderAI/better-harness#readme) and point the
marketplace source at this repository. For the interactive Inspector sample, see
the [upstream project](https://qoderai.github.io/better-harness/inspector).

## License

MIT. Original work Copyright (c) 2026 Qoder. This repository is maintained
independently by chenmudu and is not an official Qoder distribution.
