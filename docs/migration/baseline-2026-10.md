# MindMesh PR 1A：升级前行为基线

日期：2026-10-03。参考 HEAD：`c4f7c5e`；验收针对当前工作区和本次生成的 Windows unpacked 包。

## 结果

PR 1A 的本机验收完成。DSH 和 Cordis 版本未变；未引入 Runtime V2、插件安装或 Marketplace。用户已有安装器、package.json 和法律文档等改动保留。

| 检查 | 结果 |
| --- | --- |
| 修改前完整测试 | 15 个文件，181 项；178 通过、3 默认跳过；此前规划轮曾出现 1 项间歇失败 |
| 确定性复现 | 新增私聊/Space 两项受控时序测试在修复前失败：只有系统提示，待确认用户消息丢失 |
| 修改后完整测试 | 15 个文件，199 项；196 通过、3 默认跳过 |
| 新增回归 | 18 项：聊天时序 6、能力 hash/Runtime pool 9、Space 权限 3 |
| 类型检查 | 通过 |
| 生产构建 | 通过（本次 package:dir 中执行） |
| Node SDK initialize/close | 通过；临时 Home、假凭据，不请求模型 |
| Electron SDK initialize/close | 通过；复用同一临时 Home smoke 路径 |
| Playwright MCP SDK boot | 通过；开启 MINDMESH_LIVE_BROWSER 单独运行，使用假凭据 |
| 真实模型 File/Skill | 通过：读取临时标记、写入临时文件、加载 Skill 返回标记 |
| 真实模型 Shell | 通过：PowerShell 读取临时工作目录标记 |
| Windows unpacked build | 通过，Electron 44.0.0 / x64 |
| 随包依赖检查 | exit 0；377 个已遍历 Runtime 包，missing 0；解析诊断见下文 |
| 随包 SDK initialize/close | 通过；使用 MindMesh.exe 的 Node 模式及随包 SDK client、DSH entry |
| 随包 preload/CSP | 通过 |
| 随包真实 UI 与重启 | 两轮私聊、Researcher→Developer Space 协作和历史保留通过 |
| 随包编辑/删除/退出 | Space 编辑、Agent 删除、Space 删除、workspace 设置入口和两轮正常退出通过 |
| git diff --check | 通过 |

默认跳过的三项是 opt-in Browser、File/Skill、Shell integration；本次已分别开启并通过，不代表在默认完整测试中启用了真实网络请求。真实模型测试使用已有环境凭据，未读取用户生产数据目录，未保存密钥。

## 间歇失败的根因与修复

原失败位于 `tests/app-details.test.tsx` 的 `keeps a pending message when persistence cannot be checked`。

真实触发顺序：进入会话发起初始历史读取 → 用户发送、界面加入待确认消息 → 旧历史读取返回空列表并替换消息 → 发送失败且补查失败 → 界面只剩“状态未确认”提示。

使用手动控制 Promise 完成顺序，私聊和 Space 都能稳定复现。无需增加随机 sleep 或放宽断言。

共享 `useChatController()` 新增 sendRevision：初始历史读取记下当时 revision，发送时增加 revision；旧读取只在会话仍有效且 revision 未变时更新消息。既防止覆盖失败后的待确认消息，也防止覆盖已经完成的回复。

回归覆盖：私聊/Space × 旧历史在失败期间/失败结束后返回，共四项；私聊/Space 的成功发送结束后旧历史返回，共两项。原有 DOM 回归保留，完整测试通过。

## 锁定的不变量及覆盖

| 不变量 | 验证位置 |
| --- | --- |
| 相同能力 hash 稳定；显示信息不改变能力身份 | runtime-pool.test.ts 新增 identity 测试 |
| persona、tools、skills、provider、model 改变 hash | runtime-pool.test.ts 新增参数化测试 |
| reasoningEffort 与 Skill 资源改变身份 | 现有 database-agent.test.ts / runtime-pool.test.ts |
| base/effective hash 区分、base parser 可恢复 base | runtime-pool.test.ts 新增 identity 测试 |
| 同能力复用、不同 workspace 隔离、shutdown 释放全部 | runtime-pool.test.ts 新增组合测试；现有 provider-routing.test.ts |
| stop A 不影响 B；共享活跃 Runtime 拒绝进程级 stop | runtime-pool.test.ts 新增 stop 测试 |
| active Runtime 不因空闲淘汰被关闭 | 现有 runtime-pool.test.ts |
| 私聊默认 chat=[]、workspace 排除 Shell、full 使用配置工具 | 现有 chat-flow.test.ts |
| Space 每个被提及成员受 chat/workspace/full 上限限制 | chat-flow.test.ts 新增三项参数化测试；保留默认权限测试 |
| 已有 persona 快照保持、改名不重建 Session | 现有 chat-flow.test.ts / database-agent.test.ts |
| SQLite 重开保存快照、消费游标、消息 | 现有 database-agent.test.ts；真实 packaged 双轮重启 |
| SDK resume 明确失败后 fresh session + 历史补注入 | 现有 chat-flow.test.ts、model-provider-runtime.test.ts；真实 packaged 重启 |
| Space 只注入未消费共享消息，停止回复标为不完整 | 现有 chat-flow.test.ts / domain.test.ts |
| 子进程环境限制、Provider 路由、所选工具 patch | 现有 provider-routing.test.ts、capabilities.test.ts；真实 File/Skill/Shell smoke |

## 版本与依赖基线

- 应用：MindMesh 0.1.0；Node 24.14.0；packageManager pnpm 11.7.0。
- Electron：44.0.0；本次 electron-builder 输出版本：26.15.3。
- 29 个 direct DSH 包均声明并实际解析为 `0.1.6-alpha.2`。
- SDK client 当前 peers：Cordis `^4.0.2`、dsh-llm / dsh-sdk-protocol / dsh-session 均为 `^0.1.6-alpha.2`。
- Cordis 4.0.2 当前 peers：cordis-plugin-loader `^1.0.3`、cordis-plugin-include `^1.0.7`。
- cordis-plugin-group 1.0.2 当前 peers：cordis-plugin-loader `^1.0.3`、Cordis `^4.0.2`。
- 当前版本矩阵来自本地 package.json 和已安装包 manifest；不包含目标升级版本的兼容承诺。PR 1B 再生成 published metadata/peer 闭包矩阵。

| Direct package | 声明版本 | 本地解析版本 |
| --- | --- | --- |
| @deepseek-ai/cordis | 4.0.2 | 4.0.2 |
| @deepseek-ai/cordis-plugin-group | 1.0.2 | 1.0.2 |
| @deepseek-ai/dsh | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-anonymous-user-id | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-attachment | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-authorization | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-bash-local | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-client-ui-primitives | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-client-ui-slots | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-compaction | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-fs | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-hook-protocol | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-jobs | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-llm | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-output-retention | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-ptc-runtime | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-sandbox | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-sdk-client | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-sdk-protocol | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-session | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-session-persistence | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-session-query | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-session-telemetry | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-session-title-llm | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-settings | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-shell | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-spill | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-subagent-in-process-driver | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-util-time | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-util-workspace-path | 0.1.6-alpha.2 | 0.1.6-alpha.2 |
| @deepseek-ai/dsh-workflow | 0.1.6-alpha.2 | 0.1.6-alpha.2 |

## 验证命令

从项目根目录执行。模型测试需要已有 DEEPSEEK_API_KEY；命令不包含真实密钥。

```powershell
corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 test
corepack pnpm@11.7.0 exec vitest run tests/app-details.test.tsx -t 'initial history read finishes'
corepack pnpm@11.7.0 poc:harness
corepack pnpm@11.7.0 poc:harness:electron

# 无真实凭据的 Browser boot，结束后恢复原环境
$baselineSavedKey = $env:DEEPSEEK_API_KEY
try {
  $env:MINDMESH_LIVE_BROWSER = '1'
  $env:DEEPSEEK_API_KEY = 'mindmesh-keyless-smoke'
  corepack pnpm@11.7.0 exec vitest run tests/capabilities.test.ts -t 'starts the real SDK with Playwright MCP'
} finally {
  $env:DEEPSEEK_API_KEY = $baselineSavedKey
  Remove-Item Env:MINDMESH_LIVE_BROWSER -ErrorAction SilentlyContinue
}

# 使用已有凭据的 File/Skill/Shell，写入一次性临时 workspace
try {
  $env:MINDMESH_LIVE_CAPABILITIES = '1'
  corepack pnpm@11.7.0 exec vitest run tests/capabilities.test.ts -t 'starts the real SDK with the selected capability patch|runs the selected Shell tool in the workspace'
} finally {
  Remove-Item Env:MINDMESH_LIVE_CAPABILITIES -ErrorAction SilentlyContinue
}

corepack pnpm@11.7.0 package:dir
corepack pnpm@11.7.0 check:package-deps

# 随包 SDK client + DSH，使用假凭据，仅 initialize/close
try {
  $env:MINDMESH_SMOKE_RUNTIME_ROOT = Join-Path $PWD 'release\win-unpacked\resources\app.asar.unpacked\node_modules'
  $env:ELECTRON_RUN_AS_NODE = '1'
  & '.\release\win-unpacked\MindMesh.exe' '.\scripts\harness-smoke.mjs' | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Packaged SDK smoke failed' }
} finally {
  Remove-Item Env:MINDMESH_SMOKE_RUNTIME_ROOT, Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}

try {
  $env:MINDMESH_E2E_EXE = Join-Path $PWD 'release\win-unpacked\MindMesh.exe'
  node scripts/electron-e2e-smoke.mjs --security-only
  $env:MINDMESH_E2E_RESTART = '1'
  node scripts/electron-e2e-smoke.mjs
} finally {
  Remove-Item Env:MINDMESH_E2E_EXE, Env:MINDMESH_E2E_RESTART -ErrorAction SilentlyContinue
}
```

`harness-smoke.mjs` 每次新建临时 DSH_HOME，使用系统变量白名单与固定假凭据，await close 后检查临时路径并清理。Electron wrapper 复用它。设置 MINDMESH_SMOKE_RUNTIME_ROOT 时同时从该根目录加载 SDK client 与 DSH，不使用开发目录的 SDK 替代随包 SDK。

## 已知限制与未覆盖项

1. 当前 `check-packaged-deps.mjs` 使用 CommonJS resolve，不完整支持 import-only exports，并把 optional peer 也列入 unresolved。实际输出中的 unicorn-magic、@octokit/webhooks-methods、@earendil-works/pi-ai 均有随包 package.json；bufferutil、utf-8-validate 是 ws 的 optional peers，包内不存在；signal-exit 的 dist/cjs/package.json 没有 name，检查器将其误识别为无名 package root。因此 missing 0 只覆盖它成功遍历的 377 个包，不能宣称整个运行依赖图毫无遗漏。PR 1B 的矩阵/依赖检查要完善这部分。
2. 本次 Browser smoke 验证开发依赖路径下 SDK + Playwright MCP 的 initialize/close，未验证模型驱动网页导航，也未单独验证随包 Browser 调用。
3. 本次真实模型回归为 DeepSeek；其他服务未重新进行带凭据验收，已有 mock 路由测试通过。
4. 本次生成并运行 Windows unpacked 包，没有重新生成 NSIS、安装/卸载或运行干净 VM。package:dir 与本机 packaged smoke 通过不等价于干净 VM 发布验收。
5. 当前 SDK 跨进程 session 恢复限制、无 per-turn cancel 的限制继续保持；应用依赖现有 fresh session/历史补注入以及独占 Runtime 关闭策略。
6. 仅保存本地结果，不创建远程 PR 或上传日志。后续执行 PR 1B 应从此基线比较；不自动继续实现后续阶段。
