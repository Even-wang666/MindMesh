# Phase 2：Conversation Control

实施日期：2026-10-06。范围依据《MindMesh-合并修正版实施路线图》Phase 2；代码起点为 `2e625a5`。

## 已实现

- Agent 私聊和 Space 均支持新建、切换、重命名、归档对话。归档保留历史，可从列表浏览；归档对话不显示输入框。
- Message 写入、执行历史、Runtime 事件、停止请求和 Session key 全程使用显式 conversationId。旧调用未传 ID 时仍使用原默认对话。
- 仅重新生成最后一条用户消息对应的执行，不重复插入用户消息。新的 Execution 使用原 triggerMessageId，递增 generationIndex，并指向上一代 Execution。
- Space 重试复用原 workflowSnapshot 的参与者和顺序。原成员已删除时拒绝重试。
- 重试保留 `conversation:${conversationId}:${agentId}`，释放旧运行租约，并调用 restartRuntimeSession 创建新 Harness Session；重建的模型历史过滤旧代回复。
- 每轮默认显示最新回答版本，可浏览旧代；切换只改变显示，不创建 Execution。旧 Message、Run 和工具审计记录均保留。
- Agent 回复支持复制，并反馈复制结果。
- 重试中途准备失败时关闭 Execution，保留已产生的回复并刷新版本列表。消息和版本查询具备切换/发送竞态保护。

## 验证入口

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm smoke:electron
pnpm smoke:security
pnpm smoke:plugins
node scripts/electron-e2e-smoke.mjs --conversation-control
$env:MINDMESH_E2E_RESTART='1'
node scripts/electron-e2e-smoke.mjs --conversation-control
```

`--conversation-control` 使用隔离用户目录和本地演示模式，验证界面操作、Space IPC 和重启后历史保留；`--conversation-control-live` 使用当前 DeepSeek 测试凭据验证真实 Harness 的重新生成。

针对性检查位于 `tests/conversation-control.test.ts`、`tests/conversation-control-ui.test.tsx`，以及 `tests/app-details.test.tsx` 的版本切换回归测试。

2026-10-06 本地验收结果：

- 完整测试集 46 个文件通过，418 项通过，3 项原有跳过；typecheck、lint、build 通过。
- `smoke:electron` 真实模型私聊、Space 顺序协作、编辑/删除与正常退出通过；`smoke:security` 和 `smoke:plugins` 通过。
- Phase 2 演示模式两轮 Electron 重启通过，归档历史及两代 Execution 保留。
- `node scripts/electron-e2e-smoke.mjs --conversation-control-live` 通过：真实 Harness 私聊重新生成、Space 整组重新生成、历史版本保留和浏览可用。
- code-review 两轴复核通过。查询竞态、重试失败后漏刷新及切换对话后版本显示不一致均已修复并覆盖回归测试。

## 阶段边界

本阶段复用 Phase 1 已有表结构，没有新 schema migration。Artifact 表和成果捕获属于 Phase 3；目前 Message / Execution / Run 已归属 Conversation，Phase 3 的 Artifact 将沿用 conversationId 和 executionId。

没有实现历史消息编辑、Fork、并行 Space 执行或可选的 Skill deterministic validation。代码和提交仅保存在本地。
