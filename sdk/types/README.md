# @vmotion/sdk 类型声明

这里只有 TypeScript 类型声明（`.d.ts`），没有任何实现代码。Vmotion 在编译工程里的组件和插件时会自动提供真正的 `@vmotion/sdk` 运行时与 JSX 运行时；这些声明只用于编辑器补全和 `tsc --noEmit` 类型检查。

| 文件 | 对应导入 |
|---|---|
| `index.d.ts` | `@vmotion/sdk`：`defineComponent`、节点工厂、时间 / 动画 / 效果工具、`definePlugin` / `definePluginTool`、`PluginContext` / `PluginCandidate`（插件 worker 协议）、`PluginManifest` 等 |
| `jsx-runtime.d.ts` / `jsx-dev-runtime.d.ts` | `@vmotion/sdk/jsx-runtime`（`.tsx` 组件的 `jsxImportSource`）及 `JSX` 命名空间 |

版本号写在 `index.d.ts` 顶部注释里，对应同版本的便携包。部分类型由 Vmotion 的工程格式 Schema 推导，引用了 [`zod`](https://zod.dev) 的类型，所以 `package.json` 依赖 `zod`；用 `file:` 链接安装时 npm 不会安装链接包的依赖，请在自己的工程里同时装上 `zod`（见下例）。

## 在自己的工程里使用

```jsonc
// package.json（只用于类型检查，不参与 Vmotion 渲染）
{ "private": true, "devDependencies": { "@vmotion/sdk": "file:<本仓库>/sdk/types", "typescript": "^5.9.3", "zod": "^3.25.76" } }
```

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "jsx": "react-jsx", "jsxImportSource": "@vmotion/sdk",
    "strict": true, "noEmit": true, "skipLibCheck": true, "types": [],
    "preserveSymlinks": true // 让 file: 链接的类型包从本工程 node_modules 找到 zod
  },
  "include": ["components/**/*.ts", "components/**/*.tsx"]
}
```

完整可运行的例子见仓库的 [`examples/`](../../examples/)。
