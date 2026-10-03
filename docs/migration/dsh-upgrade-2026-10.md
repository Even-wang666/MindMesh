# MindMesh PR 1B：DSH 升级验收

日期：2026-10-03。升级前参考：`c4f7c5e` 加当前工作区已完成的 PR 1A。
范围：依赖兼容集、运行版本查询、能力 patch、依赖闭包检查及必要回归；未实施 Runtime V2、Supervisor、Plugin DB 或 Marketplace。

## 固定的兼容集

- 原有 29 个 direct DSH 包由 `0.1.6-alpha.2` 升级到 `0.2.0-rc.2`。
- Cordis：`4.0.2` → `4.0.4`；cordis-plugin-group：`1.0.2` → `1.0.4`。
- 新增 3 个 exact direct 运行包：`dsh-client-store`、`dsh-deepseek-account`、`dsh-llm-deepseek`，均为 `0.2.0-rc.2`。
- 合计 34 个 DSH/Cordis direct 包；本机运行图 533 个解析实例；required dependency/peer 失败 0；pnpm peers 无冲突。
- 完整直接版本、发布包 peer 要求及实际 DSH/Cordis 传递版本见 [版本矩阵](../dsh-version-matrix.md)。矩阵来自已安装的目标发行包 manifest，校验不依赖 latest 标签或 master 源码。

初选 group `1.0.3` 不满足传递包 `dsh-app-boot@0.2.0-rc.2` 的 `~1.0.4`，因此选择 `1.0.4`。第一次 Windows 包构建虽成功，闭包检查发现 5 条 required 缺失边，归结为上面 3 个 peer-only 包未被 electron-builder 分发；补为直接依赖后重新打包，不放宽检查器。

## 必要兼容调整

- `getDshRuntimeInfo()` 从实际 dev/bundled manifest 读取版本及对应 CLI 路径，不另写版本常量；Adapter 用同一 helper 启动。
- `runtime.status()` 返回可选 `dshVersion`，demo、ready、running 均可查询；services 的 error 状态保留这一字段。E2E 通过 Renderer/Preload 查询，并与项目 exact 版本比较。
- 正式 capability patch 显式关闭 `tool-plugin-manager` 与未列入产品工具目录的 `tool-ralph`。SDK 默认已经关闭二者，本次保留并明确锁定该边界。
- 真实 CLI `--dump-config` 回归验证 chat/workspace/full；chat 无 callable tools，workspace 无 Shell，full 按已选目录启用工具。既有 Skill、MCP 插入及 provider patch 仍兼容。
- 不改变能力 hash、权限产品语义、persona 快照、Session 历史补注入或运行池生命周期。

## 检查器修复

旧检查器通过 CommonJS entry 反推包根，误报 import-only 包和 exports 限制，也可能把 signal-exit 的嵌套无名 manifest 当成包。它只按包名去重，并且对 required 解析失败未设置失败退出码。

新检查器沿 Node 的 package 搜索路径直接读取具名 manifest，逐个真实解析实例遍历；dependency 与 peer 对同名包的约束分别检查，不相互覆盖。缺失 required 和版本不满足都失败。

打包检查从随包包根遍历，realpath boundary 禁止回退到仓库依赖；覆盖全部 DSH/Cordis direct 包及 MindMesh 插入的 Playwright MCP。npm optional 本身不代表在当前平台可省略：本机已安装的 optional 运行依赖（例如 Windows ripgrep native payload）若随包缺失，也失败。其他平台的 optional native 包及本机未安装的 optional peer 单列提示。

复用 electron-builder 已有 semver 校验器，未增加新的运行依赖。CI 增加 `check:dsh-deps`，Windows 继续执行强化后的 `check:package-deps`。

## 验收记录

| 检查 | 结果 |
| --- | --- |
| frozen-lockfile install | 通过 |
| 类型检查 | 通过 |
| 直接版本与传递运行矩阵 | 34 direct、533 runtime instances、required 失败 0 |
| pnpm peers check | 无冲突 |
| 新增升级 gate | 9 项全部通过；版本读取、受限 exports、缺失/不兼容、包边界、平台 native 与三权限配置 |
| 最终完整测试 | 16 文件、208 项；205 通过、3 默认跳过 |
| SDK Node initialize/close | 通过；临时 Home、假凭据，不请求模型 |
| SDK Electron initialize/close | 通过 |
| Playwright MCP initialize | 通过；单独开启 opt-in 测试 |
| 真实 File / Skill / Shell | 通过；临时 workspace 标记读写、Skill 加载、PowerShell 标记读取 |
| 图像及思考单元回归 | 既有 image blocks、reasoning 通知、最终正文及中间 trace 测试通过 |
| 真实图像 / high reasoning | 生成 64×64 红色 PNG，模型识别红色，收到非空 reasoning block，通过 |
| Windows 最终 unpacked | 通过；Electron 44.0.0 / x64，electron-builder 26.15.3 |
| 随包闭包 | 585 运行实例，required 失败 0；72 条其他平台 optional/未安装 optional peer 缺失提示 |
| 随包 SDK handshake / close | 通过；MindMesh.exe Node 模式，随包 SDK 与 CLI，假凭据 |
| 随包 preload / CSP | 通过 |
| 随包真实双轮私聊 / Space / 重启 | 通过；两轮私聊、Researcher→Developer Space、历史保留及正常退出；Space 编辑、Agent/Space 删除、workspace 入口通过 |

默认完整测试不隐式请求模型；三个 opt-in 项已分别运行并通过。真实请求使用已有环境凭据，测试均在临时数据目录，不访问用户生产会话，不记录密钥。Browser 验证限于 MCP 启动和 SDK initialize，不等同于真实网页导航。

最终 unpacked 目录约 1086.1 MiB（含 Electron 与完整 CLI 运行依赖）。开发与随包运行图实例数不同，是因为分发后的解析布局使部分 optional peer 也可解析；两边的约束均独立验证，不以相同实例数作为兼容条件。

## 复现

从仓库根目录执行，真实模型命令需要已有 `DEEPSEEK_API_KEY`。

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 check:dsh-deps --write
corepack pnpm@11.7.0 peers check
corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 test
corepack pnpm@11.7.0 poc:harness
corepack pnpm@11.7.0 poc:harness:electron

$env:MINDMESH_LIVE_BROWSER = '1'
corepack pnpm@11.7.0 exec vitest run tests/capabilities.test.ts -t 'Playwright MCP'
Remove-Item Env:MINDMESH_LIVE_BROWSER

$env:MINDMESH_LIVE_CAPABILITIES = '1'
corepack pnpm@11.7.0 exec vitest run tests/capabilities.test.ts
Remove-Item Env:MINDMESH_LIVE_CAPABILITIES
node scripts/harness-media-smoke.mjs

corepack pnpm@11.7.0 package:dir
corepack pnpm@11.7.0 check:package-deps

$env:MINDMESH_SMOKE_RUNTIME_ROOT = Join-Path $PWD 'release\win-unpacked\resources\app.asar.unpacked\node_modules'
$env:ELECTRON_RUN_AS_NODE = '1'
& '.\release\win-unpacked\MindMesh.exe' '.\scripts\harness-smoke.mjs' | Out-Host
Remove-Item Env:ELECTRON_RUN_AS_NODE
Remove-Item Env:MINDMESH_SMOKE_RUNTIME_ROOT

$env:MINDMESH_E2E_EXE = Join-Path $PWD 'release\win-unpacked\MindMesh.exe'
node scripts/electron-e2e-smoke.mjs --security-only
$env:MINDMESH_E2E_RESTART = '1'
node scripts/electron-e2e-smoke.mjs
Remove-Item Env:MINDMESH_E2E_RESTART
Remove-Item Env:MINDMESH_E2E_EXE
```

## Standards

独立规范审查及主实现增量复审：0 项发现。新增 media smoke 的增量审查发现 1 个临时目录清理缺口，已用嵌套 finally 修复，0 剩余。审查依据为 AGENTS.md、codx.md、Ponytail 与 code-review 的 smell baseline；排除既有用户和 PR 1A 改动。

## Spec

初审 1 项 P2：将所有缺失 optional 包视为允许，可能放过本平台必需的 native payload，未充分满足“完整 peers/运行依赖闭包成立”。已补平台强制随包与 fixture 回归，增量复审无剩余发现。

最终审查结果：Standards 0 剩余（media cleanup 已修复）；Spec 0 剩余（原 1 项已修复）。

## 限制与回滚

本次未做 NSIS 安装/卸载、干净 VM、其他 Provider 的真实请求或 Runtime V2 迁移；最终发布验收仍按后续计划执行。生产数据目录、SQLite schema 和旧 Home 清理语义没有修改，不将新的 DSH 内部状态复制进旧 Home。

回滚时恢复升级前 package.json 的依赖与 pnpm-lock.yaml 并重新 install/build，配套回退 helper 与版本状态字段；不要删除用户 dataDir。PR 1A 和用户原有工作区改动独立保留，本次提交仅包含 PR 1B。
