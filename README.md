# vmotion-dsh

让 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的 agent 驱动本地视频工作站 **Vmotion** 的插件包（DSH 术语叫 bundle）。

- **主要能力 1：Vmotion agent 技能。** 把 Vmotion 仓库里的 `skills/vmotion`（SKILL.md + references + starter 示例）通过 DSH 的技能机制（`ctx.skills.registerProvider`，`bundled` 来源）交给模型。技能的核心规则不变：**先改工程文件，其次用 CLI，MCP 最后。**
- **主要能力 2：8 个包装 `vmotion` CLI 的工具。** 固定 argv（POSIX 下不经 shell）、参数 schema 校验、可配置超时、取消时连同子进程（native core / FFmpeg）整组终止、CLI 路径可配置。
- **不做的事：** 工具不编辑工程文件（编辑交给 agent 自带的文件工具）；默认不接 MCP（见文末可选做法）。

## 目标版本

| 项目 | 值 |
|---|---|
| 依据的 DSH 源码 | `deepseek-ai/deepseek-harness` **master @ `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`**（2026-10-23，“Merge pull request #7075”）。格式依据：`docs/user/develop/basic/{index,tool,config,publish}.md`、`docs/cookbook/adding-a-tool.md`、`docs/subsystems/skills.md`、`packages/experimental/skill-badge`、`packages/experimental/badge-skill-bundle`、`packages/mcp/mcp-client/README.md` |
| 实测运行的 DSH | npm `@deepseek-ai/dsh@0.2.1-rc.3`（Node 24.22.1，Linux arm64）。注意：master 的 package 版本号也是 `0.2.1-rc.3`，但比 `dsh-v0.2.1-rc.3` 标签多约 1400 个提交（工具执行器被拆成独立插件等）；插件作者面（`defineTool`、`ctx.tools.register`、`ctx.skills.registerProvider`、bundle/profile 清单）在两者之间一致 |
| `engines.dsh` | `>=0.2.1-rc.3 <0.3.0` |
| Vmotion | 仓库 `origin/main @ 41906d1`（技能内容来源；CLI 用该提交本地构建实测） |

## 文件结构

```
vmotion-dsh/
├── package.json          # "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }，engines.dsh，peerDependencies
├── cordis.patch.yml      # 插入两行：vmotion-skill（vmotion-dsh/skill）与 vmotion-tools（vmotion-dsh/tools）
├── index.js              # 程序化入口，重新导出两个插件
├── lib/skill.js          # 技能 provider（inject: ['skills']）
├── lib/tools.js          # 8 个工具 + Config（inject: ['tools']，可选使用 workingDirectory）
├── lib/run-cli.js        # 子进程：超时、取消、进程组终止、输出上限、环境变量脱敏
├── assets/skills/vmotion # 改编自 Vmotion skills/vmotion（Apache-2.0，见 NOTICE）
├── examples/mcp.patch.example.yml   # 可选：用 dsh-mcp-client 挂 Vmotion MCP（非主路径）
├── scripts/boot-probe.mjs           # 无 LLM 的真实启动探针
└── tests/                # node:test；unit（假 CLI）+ integration（真 CLI，需 VMOTION_CLI）
```

两个插件分成两行，是为了缺少某个服务（例如某个组合没有 `skills`）时另一个仍能加载。纯 JavaScript（带 JSDoc 类型）、无构建步骤，所以从 git 安装也不需要 `prepare`/`allowBuilds`。

## 安装

前提：Node ≥ 24.9、pnpm 在 PATH 上、已装 `dsh`（`npm i -g @deepseek-ai/dsh`）。

```sh
# 1. 装进一个 profile（第一次会以 @deepseek-ai/dsh-base 初始化该 profile）
dsh plugin --profile <profile> add link:/绝对路径/vmotion-dsh
#   pnpm 会警告“linked 包的 peerDependencies 不从目标 node_modules 解析”——这是预期的：
#   DSH 的 profile 解析会用运行中安装自带的 @deepseek-ai/* 副本满足 peer。

# 2. 告诉工具 vmotion CLI 在哪里：编辑 $DSH_HOME/profiles/<profile>/cordis.patch.yml
```

```yaml
- id: vmotion-tools
  config:
    # 任选其一：
    command: [vmotion]                                        # 全局 bin
    # command: [node, /opt/vmotion/dist/cli/index.mjs]        # 源码构建
    # command: ['C:\Vmotion\vmotion.cmd']                     # Windows 便携版（未在本仓库验证）
    env:
      VMOTION_RUNTIME: /opt/vmotion/runtime   # 源码运行时中文字体目录（含 fonts/NotoSansSC-*.otf）
      # VMOTION_NATIVE / VMOTION_FFMPEG / VMOTION_FFPROBE 按需
```

注意：patch 会**整体替换**该行的 `config`，要把需要的键都写全。

```sh
# 3. 不启动就检查组合结果与配置 schema（官方检查手段）
dsh --profile <profile> --dump-config          # 应出现 "# == vmotion-dsh" 层
dsh --profile <profile> --dump-config-schema   # x-cordis.complete 应为 true；vmotion-tools 为 status "schema"

# 4. 正常使用
dsh --profile <profile>     # 或用 web / tui 等 profile 安装：dsh plugin --profile web add link:...
```

卸载：`dsh plugin --profile <profile> remove vmotion-dsh`（同时移除依赖与层）。

master 上**没有** `dsh plugin check` 子命令（`dsh plugin` 把参数原样转给 pnpm）；上面的 `--dump-config` / `--dump-config-schema` 是官方文档给出的不启动检查方式。

## 工具列表

所有工具：`project`/`output` 可写相对路径（相对会话工作目录；无会话时相对进程 cwd），返回绝对路径。返回值是统一的规范 JSON：`{ ok, exitCode, argv, cwd, durationMs, result, stderr?, outputTruncated? }`，`result` 为 CLI 输出的 JSON。

| 工具 | 运行的 CLI | 说明 |
|---|---|---|
| `vmotion_doctor` | `vmotion --version` + 环境探测 | CLI 是否可启动、版本、`VMOTION_NATIVE`/`VMOTION_RUNTIME` 字体/FFmpeg 是否找得到。CLI 不存在时返回 `ok:false`（不报错），便于排障 |
| `vmotion_context` | `vmotion context` | 场景/序列 id、时长、组件、文件 sha256、诊断；可选 `scene`/`sequence`/`offset`/`limit` |
| `vmotion_validate` | `vmotion validate --json` | 退出码 2（工程无效）是**正常结果**：`ok:false`、`result.diagnostics` |
| `vmotion_frame` | `vmotion frame` | 渲染单帧 PNG；`width`/`height` 必须成对；默认输出 `<project>/exports/dsh/frame-<n>.png` |
| `vmotion_sample` | `vmotion sample` | 1–12 帧拼成一张联系表 PNG |
| `vmotion_image_export` | `vmotion image export` | 静态图工程导出 png/jpeg/webp，`scale`/`quality`/`transparent`/`trim` |
| `vmotion_render` | `vmotion render` | 导出 mp4/png 序列/wav；`start`/`end`/`width`/`height`/`encoder`/`codec`/`resume`；退出码 3（任务未完成）是正常结果 `ok:false` |
| `vmotion_encoders` | `vmotion encoders` | 实测哪些 H.264/HEVC/AV1 编码器可用；CLI 需要加载一个工程（读取其导出设置），所以要传 `project` |

错误语义（遵循 DSH `execute()` 约定）：参数非法、工程目录不存在/不是 Vmotion 工程、CLI 找不到、CLI 退出码 1（带 `{"error":{code,message}}`）、超时、取消 → 工具错误（`isError`）；validate 的 2、render 的 3 → 成功结果里的 `ok:false`。

## 配置（`vmotion-tools` 行）

| 键 | 默认 | 说明 |
|---|---|---|
| `command` | `["vmotion"]` | 启动 CLI 的 argv 前缀（至少 1 项） |
| `env` | `{}` | 额外环境变量，合并在“脱敏后的环境”之上 |
| `timeoutMs` | `180000` | doctor/context/validate/frame/sample 的期限 |
| `renderTimeoutMs` | `3600000` | render、image export、encoders 的期限 |
| `maxOutputBytes` | `8 MiB` | 每个输出流的捕获上限 |
| `maxResultChars` | `20000` | 给模型看的 JSON 文本上限（超出截断并提示） |
| `killGraceMs` | `3000` | 取消/超时时 SIGTERM → SIGKILL 的宽限 |
| `disabledTools` | `[]` | 不注册的工具名 |

环境变量脱敏：与 `dsh-mcp-client` stdio 相同规则，名字匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的环境变量和所有 `DSH_*` 不会传给 vmotion，除非在 `env` 里显式配置。

`vmotion-skill` 行没有配置项（导出了空的 `Config`，让配置工具显示 schema 而不是“未知字段”）。

## 测试

```sh
# 单元测试（无需 Vmotion）：用已安装 DSH 的真实 tools/skills 注册表 + 假 CLI
npm test

# 加上真实 CLI 集成测试（启动 starter 工程，渲染帧/联系表/短 MP4/静态图，取消渲染）
VMOTION_CLI='["node","/path/vmotion/dist/cli/index.mjs"]' \
VMOTION_NATIVE=/path/vmotion-core VMOTION_RUNTIME=/path/runtime npm test
```

测试通过 `tests/support/dsh-hooks.mjs` 把 `@deepseek-ai/*` 解析到已安装的 DSH（模拟 DSH 给 linked bundle 提供 peer 的方式）；安装位置从 PATH 上的 `dsh` 推出，或用 `DSH_INSTALL_DIR` 指定。整个测试**不调用任何模型、不用任何 API key**。

无 LLM 的真实启动探针：

```sh
# boot-probe.patch.yml 里写绝对路径：
# - insert:
#     - id: vmotion-boot-probe
#       name: '/绝对路径/vmotion-dsh/scripts/boot-probe.mjs'
VMOTION_PROBE_PROJECT=/path/to/project VMOTION_PROBE_OUT=/tmp/probe.json \
  dsh --profile <profile> --patch ./boot-probe.patch.yml
```

探针在真实启动的组合里列出技能与工具，经真实工具管线运行 `vmotion_doctor`、`vmotion_validate`、`vmotion_frame`，写出 JSON 后退出。

## 可选：通过 MCP 挂 Vmotion（不是主路径）

只有文件编辑 + CLI 做不到时才用（例如需要连到正在运行的 Vmotion 应用的实时状态）。见 `examples/mcp.patch.example.yml`：用 DSH 官方的 `@deepseek-ai/dsh-mcp-client`，`transport: stdio`，`command`/`args` 指向 `vmotion mcp --project <dir> --tools compact`。这会给模型增加一批 MCP 工具与较大的上下文，技能里仍要求 MCP 最后使用。本仓库**未**实际启动该 MCP 连接验证。

## 未验证 / 不确定的点

见仓库根的 `VERIFICATION.md`。
