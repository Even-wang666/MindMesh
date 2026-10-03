# MindMesh PR 3：Runtime Supervisor 验收

日期：2026-10-04。基线：`c6e7e99`。
范围：[执行规划](../plans/MindMesh-下一阶段执行规划-2026-10-03.md) PR 3：lease、starting 去重、stale/retire、错误诊断及 services 定向回收。

## 运行生命周期

- `RuntimeSupervisor` 统一拥有 Home 物化、SDK 启动握手、运行池、归属、lease、关闭和磁盘清理保护。Adapter 保留运行快照准备、模型事件/图像转换及回复归并。
- acquire 在等待启动前登记 lease。同一完整 key 共享 preparing/starting Promise；Home 物化与 SDK initialize 只执行一次。成功、失败及取消后的 release 均幂等。
- Provider 变更只标记依赖它的实例 stale，包括使用 DeepSeek 网页搜索凭据的其他模型路由；workspace 变更使旧工作目录实例 stale。旧 active lease 完成后退役，新身份请求使用新实例。
- 同一 context 的 live capability revision 改变时转移所有权；其他 context 仍可使用自己的快照。没有其他所有者的旧实例标 stale：空闲立即退役，忙碌等待释放。快速 A→B→A 不会等待未安排关闭的旧实例。
- Runtime 在 preparing、starting、busy、stale 和 closing 期间仍受 Supervisor 保护。关闭确认前不删除 key，也不让替身使用同一可写 Home。关闭失败保留 failed 条目，拒绝同 key 重新启动；其他 key 仍可使用。用户可通过重启应用处理持续失败，不将未知退出当作关闭成功。
- 延续 10 分钟空闲淘汰和既有 8 个条目的池目标；忙碌实例不能被这个目标强杀，因此并发忙碌时允许暂时超过目标。磁盘保留仍沿用 PR 2 的七天策略。

## 请求、历史与业务写回

- 正式聊天将 contextKey/requestId 作为 lease 归属。新 SDK 进程的历史补注入及明确的 Session resume 重试均在同一 lease/RuntimeRequest 内完成。
- 停止精确匹配 requestId。SDK 尚无单请求取消：只有 sole lease 可以关闭所属进程；共享实例上的停止返回失败，保护其他在途请求。关闭成功但 SDK 请求随后拒绝，也仍报告停止成功。
- Agent/Space 删除只移除相应所有者；共享实例保留，只有无其他所有者的实例在 lease 结束后退役。删除后的晚到结果不追加回复；Agent 删除原有历史保留约定不变。
- Session 进度更新增加 expected capabilityHash/Session ID 条件，旧 generation 的晚到回复不能覆盖新 Session ID/Space 消费游标。workspace 切换清除 Session 映射但保留消息，旧请求可完成而不会重建旧映射。
- shutdownAll 仅用于应用退出，拒绝后续 acquire，覆盖正在启动和运行的进程；services 继续沿用 15 秒退出宽限和停止后续 Space 成员执行的约定。

## 错误与诊断

- 分类包含 materialization/startup/transport-closed/protocol/request-timeout/provider/unknown，并保留后续 profile/plugin 扩展所需的已有方案分类名。
- materialization/startup 失败清理后可以重新 acquire。transport/protocol/timeout 将实例标 failed/stale，其他 lease 完成后关闭；超时不会被当作服务器已停止处理。
- Provider 错误保留同一实例供用户重试，不自动重发模型请求。
- Main 的运行诊断包含 key、状态、activeLeaseCount、stale、lastUsedAt、安全 lastError kind/时间。现有 RuntimeStatus.detail 和聊天失败说明使用中文安全分类，failed 实例不显示“正常运行”。JSONL 仅增加安全 kind，不保存 cause、原始错误、提示词或凭据。

## 验收记录

| 检查 | 结果 |
| --- | --- |
| Supervisor 回归 | 20 项通过：starting 去重、generation 在途、失败/超时、关闭确认、请求取消、删除归属、条件写回、A→B→A 及启动失败退役 |
| typecheck | 通过 |
| build | 通过 |
| 开发 Electron 双轮真实模型 smoke | 私聊、Space、重启、编辑/删除、设置、单实例与两轮正常退出通过 |
| 最终全量测试 | 18 文件；232 通过、3 条既有可选集成测试默认跳过 |
| Windows unpacked build | 通过，产物 `release/win-unpacked/MindMesh.exe` |
| 打包依赖闭包 | 585 runtime instances；required failures 0；72 条平台/可选依赖提示 |
| 打包版双轮真实模型 smoke | 私聊、Space、重启、编辑/删除、设置、单实例与两轮正常退出通过 |

首次全量测试与 Windows 打包同时运行时，既有 Renderer `reveals a complete model reply gradually after it arrives` 的 `findByText` 等待超时：231 通过、1 失败、3 默认跳过。未修改 Renderer 或放宽断言；单独重跑该文件 60 项全部通过，逐字展示用例约 634 ms。最终完整测试结果见上表。

## Standards

初审发现 ownership transfer 的旧 idle stale 实例未安排退役，会阻塞切回或在新实例启动失败时遗留旧实例。已修复并补两项先红后绿回归。最终复审硬标准问题 0 项、判断性问题 0 项。

## Spec

初审发现错误分类未接用户可见状态，以及上述 idle stale 退役遗漏。均已修复。最终复审剩余 0 项。

两轴均无剩余发现。

## 复现与后续

运行 `pnpm typecheck`、`pnpm test`、`pnpm build`。针对 lifecycle 可执行 `pnpm exec vitest run tests/runtime-supervisor.test.ts`。
打包执行 `pnpm package:dir`、`node scripts/check-packaged-deps.mjs`。
带已有 `DEEPSEEK_API_KEY`，设置 `MINDMESH_E2E_RESTART=1`、`MINDMESH_E2E_SECOND_INSTANCE=1` 后运行 `node scripts/electron-e2e-smoke.mjs`；打包版本再设置 `MINDMESH_E2E_EXE` 为 `release/win-unpacked/MindMesh.exe` 的绝对路径。使用脚本生成的临时 userData。

没有新增依赖或 DB schema；不实现 Plugin DB、staging 或 Marketplace。下一项为 PR 4 Plugin 控制面与 staging。回滚保留整个 dataDir；既有 SQLite 和 PR 2 namespace 仍兼容，不为回滚删除用户数据。
