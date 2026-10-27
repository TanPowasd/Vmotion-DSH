# 验证记录

全部验证在 Linux arm64 沙箱完成，**没有调用任何模型，没有使用任何 API key**。证据文件在 `test-results/`。

## 环境

| 项 | 值 |
|---|---|
| DSH 源码依据 | master `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`（2026-10-23） |
| DSH 运行版本 | npm `@deepseek-ai/dsh@0.2.1-rc.3`，`DSH_HOME` 为隔离目录，profile `vmtest`（`@deepseek-ai/dsh-base` + `vmotion-dsh`） |
| Node / pnpm | 24.22.1 / pnpm 12.14.0（由 dsh 调用） |
| Vmotion | `origin/main` `41906d1` 的独立 worktree，本地 `scripts/build.ts` 构建 `dist/cli/index.mjs`；native core `vmotion-core-e08675e71945c05e`；系统 FFmpeg；`work/runtime` 中文字体 |

## 结果

| 检查 | 方式 | 结果 |
|---|---|---|
| 安装 | `dsh plugin --profile vmtest add link:<dir>` | 成功；`dsh.profile.bundles` 自动追加 `vmotion-dsh`。pnpm 打印 linked 包 peer 警告（文档说明的预期行为） |
| 组合（不启动） | `dsh --profile vmtest --dump-config` | 出现 `# == vmotion-dsh` 层与两行（`test-results/dump-config.vmotion.txt`） |
| 官方配置检查 | `dsh --profile vmtest --dump-config-schema` | `x-cordis.complete: true`，0 条 diagnostics，98 个 entry 无 error/partial；`vmotion-skill`、`vmotion-tools` 均为 `status: "schema"`（`test-results/dump-config-schema.vmotion.json`） |
| 真实启动加载 | `dsh --profile vmtest --patch boot-probe.patch.yml`（探针插件） | 启动无 “entry did not activate” 警告；探针看到 `vmotion` 技能（bundled / provider vmotion-dsh）与 8 个工具；经真实工具管线跑通 `vmotion_doctor`、`vmotion_validate`（valid）、`vmotion_frame`（PNG），配置来自 profile patch（`test-results/boot-probe.json`） |
| 单元测试 | `npm test`（真实 DSH tools/skills 注册表 + 假 CLI） | 14/14 通过：清单、插件形态、技能目录/正文/资源、8 工具注册与 disabledTools、argv 构造、参数校验、退出码语义、CLI 缺失、环境脱敏、Windows 引号规划、超时与取消杀进程组、卸载清理 |
| 集成测试 | `VMOTION_CLI=… npm test`（真实 CLI + starter 工程） | doctor/context/validate、单帧 1280×720 与 320×180 PNG、联系表 PNG、非法编辑→exit 2 + JSX 诊断、15 帧 320×180 MP4（ftyp）、encoders、静态图工程 PNG 导出、渲染中途取消 —— 全部通过（`test-results/node-test.log`） |
| 断言区分度 | 定点变异 | 去掉环境脱敏 → env 测试红；把进程组 kill 改成单进程 kill → 超时/取消两测试红；把 validate 的 exit 2 当错误 → 退出码测试红 |

## 发现的问题

1. **`vmotion encoders` 需要工程。** CLI 帮助/技能 cli.md 写法像“无需工程”，但它是 `projectCommand`，在非工程目录会报 `ENOENT …/project.vmotion.json`。插件的 `vmotion_encoders` 因此要求 `project`。（Vmotion 侧文档可考虑补充；本任务不改 Vmotion 仓库。）
2. **可选 MCP 路径在 Linux 上跑不通（Vmotion 问题）。** `vmotion mcp` 为每个工程绑定 `/tmp/vmotion-<hash>.sock`，进程被终止后不删除该 socket 文件；下一个同工程的 `vmotion mcp` 报 `listen EADDRINUSE`。DSH 的 `dsh-mcp-client` 在 stdio 下先起一个探测进程再起服务进程，所以服务进程必然撞上残留 socket，初始发现 60 s 超时。最小复现：对同一工程连续两次启动 `vmotion mcp` 并在第一次后 SIGTERM。CLI 命令本身不受残留 socket 影响（已验证 validate 正常）。测试里以 `todo` 记录（`tests/integration.test.mjs`），示例配置本身通过 `dsh-mcp-client` 的 Config 校验。Windows 命名管道不留文件，推断不受影响（未验证）。

## 未验证

- **Windows**（含便携版 `vmotion.cmd`、桌面应用）：`.cmd` 经 `cmd.exe /d /s /c` 的引号规则只做了单元级规划测试；`taskkill /T /F` 进程树终止未实测。
- **DSH master 源码运行时**：实测用的是 npm 0.2.1-rc.3。master 已把工具执行拆成独立执行器插件（`tool-executor-native`/`ptc`）、`ctx.tools.execute` 改为批量 `{ calls }`；插件作者面（`defineTool`、`ctx.tools.register`、`ctx.skills.registerProvider`、bundle 清单、`engines.dsh`）在 rc.3 标签与 master 之间无差异（已 diff `schema.ts`、`skill/src/index.ts`、`app-boot`、`apps/cli/src/plugin.ts`）。测试辅助 `callTool` 两种返回形状都兼容，但未在 master 源码构建上实跑。
- **真实模型回合**：按要求没有任何 LLM 调用，所以没验证模型是否会按技能顺序选工具、技能目录注入（`dsh-tool-skill` 的 `<available_skills>`）在真实会话中的呈现。
- **会话工作目录**：相对路径按 `workingDirectory.ensure(agent)` 解析的分支只在有 agent 的真实会话里走到；测试与探针都是无 agent 调用（回落到进程 cwd）。
- **Web UI 卡片**：未定义 `presentCall`/`presentResult`，界面使用通用工具卡片。
- **PTC 模式**：按 DSH 文档，注册的工具在 PTC 下自动可用（`await tools.vmotion_validate(...)`），未实测。

## 对格式不确定的点

- **Cordis 4 没有可选注入**（`inject` 全是必需项）。为了在没有 `workingDirectory` 服务的组合里也能加载，工具插件用 `ctx.inject(['workingDirectory'], …)` 子 fiber 拿服务引用。这是 Cordis 正规 API，但不是文档里展示的写法。
- **技能 provider 的 `path`/`locator`**：参照官方 `dsh-skill-badge`，`locator` 用文件 URL 字符串，额外给了 `path`（文档说 provider 可提供绝对路径，模型目录不会展示它）。
- **`engines.dsh` 用了预发布范围 `>=0.2.1-rc.3 <0.3.0`**：安装时 DSH 通过；正式 0.2.x 发布后的行为按 SemVer 也满足，但未实测。
- **peerDependencies 版本范围**写成 `>=0.2.1-rc.3 <0.3.0`；官方包用精确版本/`workspace:`，第三方包怎么写最好文档未规定。
- **超时双保险**：同时设置了 `defineTool({ timeoutMs })`（DSH 的“协作式超时预算”）和插件自己的硬期限，二者取值相同；DSH 的预算具体如何作用于 `exec.signal` 未深究。
- 没有 `dsh plugin check` 命令（master 的 `dsh plugin` 直接转发给 pnpm），用 `--dump-config` / `--dump-config-schema` 作为官方检查手段。
