# Vmotion

Vmotion 是本地运行的可编程视频创作工作站（Windows 10/11 x64）。工程以 JSON + TypeScript/JSX 保存在普通文件夹里：人在 Vmotion Studio 界面中做动画、剪辑、音乐、绘画、图片和文字；外部 AI（Claude Code、Codex、Cursor 等）通过改文件、命令行或 MCP 操作同一个工程，与界面共用预检、保存和撤销历史。程序本身不调用任何 AI 模型。

**[下载便携版（Releases）](https://github.com/TanPowasd/video-motion-studio-release/releases)** · [创作指南](docs/STUDIO-GUIDE.md) · [能力与边界](docs/FEATURES.md) · [外部 AI](docs/AGENT-WORKBENCH.md) · [插件](docs/PLUGINS.md) · [文档目录](docs/README.md)

> **源码不公开。** 本仓库只发布便携版下载、用户文档、外部 AI 用的 Agent Skill、工程文件 JSON Schema、插件 / JSX 组件作者用的 TypeScript 类型声明和示例。

## 快速开始（便携版）

1. 在 [Releases](https://github.com/TanPowasd/video-motion-studio-release/releases) 下载最新的 `Vmotion-Windows-x64-Portable.zip`，可用同名 `.sha256` 校验完整性。
2. **完整解压**到任意可写目录（支持中文和空格路径），双击 `Vmotion.exe`。无需安装 Node.js、FFmpeg、Rust 或编译器，编辑、预览和导出均可离线运行。
3. 在首页新建空白工程（或科普示例），也可以打开任意含 `project.vmotion.json` 的文件夹。
4. 设置与最近项目默认保存在包内 `profile` 目录。升级时解压到新目录，再复制旧的 `profile`；不要覆盖正在运行的程序。

包内的 `vmotion.cmd` 是命令行 / MCP 入口：

```powershell
.\vmotion.cmd init --project "D:\视频工程" --name "我的视频"
.\vmotion.cmd validate --project "D:\视频工程" --json
.\vmotion.cmd frame --project "D:\视频工程" --frame 90 --output frame.png
.\vmotion.cmd render --project "D:\视频工程" --output "D:\视频工程\exports\video.mp4"
```

更多说明见 [便携版](docs/PORTABLE.md)、[创作指南](docs/STUDIO-GUIDE.md)。示例工程随便携包提供，位于 `Vmotion\resources\app\examples\`。

## 外部 AI / Agent Skill

给外部 AI agent 使用的技能包在 [`skills/vmotion/`](skills/vmotion/README.md)（Agent Skills 格式）。把整个文件夹复制到 agent 的技能目录，例如 `~/.claude/skills/vmotion/` 或 `~/.codex/skills/vmotion/`。

使用顺序：

1. **优先直接改工程文件**：`components/*.tsx|*.ts`、`scenes/*.json`、`sequences/*.json`、`project.vmotion.json`。改动可 diff、可审阅；打开的 Vmotion 窗口会热加载有效修改，并在变更记录中标为 AI 的文件修改，可在界面撤销。
2. **其次用命令行**：`vmotion.cmd validate / sample / frame / render / tool-call …` 校验、看帧和导出。
3. **最后才用 MCP**：`vmotion.cmd mcp --project <工程目录>`。只有文件和命令行做不到、或客户端只支持 MCP 时使用。Studio 顶部"连接 MCP"可复制配置；默认 10 个紧凑入口，其余能力按需发现，见 [Agent 按需工具发现](docs/AGENT-DISCOVERY.md)。

工程文件格式的 JSON Schema 在 [`schemas/`](schemas/)。

## 插件与 JSX 组件开发

- **JSX / TSX 组件**：`components/*.tsx` 导出 `defineComponent({ name, parameters, render(ctx, params) })`，从 `@vmotion/sdk` 导入元素和时间工具。说明见 [JSX / TSX 组件](docs/JSX-COMPONENTS.md)、[组件参数](docs/COMPONENT-PARAMETERS.md)。
- **插件**：清单 `kind: "vmotion-plugin"`、`apiVersion: 1`，TypeScript 入口用 `definePlugin` / `definePluginTool` 定义工具；工具在插件 worker 中拿到只读工程快照，返回由 Vmotion 预检后提交的候选。可打包为 `.vmplugin` 安装。说明见 [插件与创作包](docs/PLUGINS.md)，清单 Schema 为 [`schemas/plugin.schema.json`](schemas/plugin.schema.json)。
- **类型声明**：[`sdk/types/`](sdk/types/README.md) 提供 `@vmotion/sdk`（含 `@vmotion/sdk/jsx-runtime`）的 `.d.ts`，只有类型，没有实现。运行时由 Vmotion 在编译组件 / 插件时自动提供；类型声明只用于编辑器补全和 `tsc` 检查。
- **示例**：[`examples/starter/`](examples/starter/)（3 秒 JSX 标题卡工程）、[`examples/plugin-starter/`](examples/plugin-starter/)（最小插件：一个 JSX 组件贡献 + plan / query 两个工具）。在 `examples/` 目录执行 `npm install && npx tsc --noEmit` 可用上述类型声明检查示例代码。

## 当前状态

早期预览版。全场景 GPU、专业长片 / 4K60 完整验收、HDR、ASIO/VST2、离线插件延迟补偿仍未完成；AU/macOS 尚未实机验收。能力边界见 [FEATURES](docs/FEATURES.md)。

## 许可

本仓库内容的许可见 [LICENSE](LICENSE)。便携包内的第三方组件保留各自许可：LGPL shared FFmpeg（附许可证与对应源码）、SIL OFL 字体、MIT 许可的 VST3 SDK / nlohmann-json notices 等，均随便携包分发。商业音频插件需另行安装和授权。
