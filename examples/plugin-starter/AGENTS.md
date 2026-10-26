# 插件入门示例

- `components/plugins/hello/plugin.json`：插件清单（kind=vmotion-plugin, apiVersion=1）。
- `components/plugins/hello/tools.ts`：插件入口，`definePlugin` + `definePluginTool`，在插件 worker 中运行，只返回候选。
- `components/plugins/hello/badge.tsx`：插件贡献的 JSX 组件，`scenes/intro.json` 已放置一个实例。
- 校验：`vmotion validate --project . --json`；查看插件：`vmotion tools-search --project . --plugin example.hello`。
- 调用工具（插件只能读到调用方在 `_context` 里选定、且清单 `reads` 声明过的内容）：
  `vmotion tool-call --project . --name plugin.example.hello.count_layers --request req.json`，
  其中 `req.json` 为 `{"_context": {"sceneIds": ["intro"]}}`；`place_badge` 另可传 `sceneId`、`label`、`accent`。
- 打包：`vmotion plugin pack example.hello --project . -o example.hello.vmplugin`。
