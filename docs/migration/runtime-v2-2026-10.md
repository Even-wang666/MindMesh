# MindMesh PR 2：Runtime V2 验收与迁移

日期：2026-10-04。基线：`d3740c1`。
依据：[下一阶段执行规划](../plans/MindMesh-下一阶段执行规划-2026-10-03.md) 的 PR 2。

## 运行身份与启动快照

- `prepareRun()` 固定当轮 Agent、权限、Provider 配置、workspace、Skill 内容及实际 DSH 版本。Session 身份比较、首次启动和历史恢复重试使用同一份冻结快照。
- 身份包含 Runtime schema 2、实际 DSH 版本、显式 permission、flavor、Agent 基础能力、所选 Skill 内容 revision、相关 Provider revision 和规范化 workspace。
- chat/workspace 使用 core 身份，full 使用 extended 身份；即使 tools=[]，权限身份仍不同。现阶段均沿用内置 SDK profile 和正式能力 patch，没有第三方插件。
- 已存在 workspace 使用 realpath；Windows 身份路径转小写。实际启动 cwd 保留用户路径。名称、角色及创建时间不进入能力身份；persona 保留 Session 快照，工具和思考强度跟随活配置。
- Provider revision 只覆盖所用路由及需要的 DeepSeek 网页搜索凭据，包括 URL/model/credential。以本地随机 32 字节密钥做 HMAC；密钥文件为 `runtime-v2/provider-revision.key`，revision 稳定跨重启，元数据及日志不保存 API Key 或其普通 hash。
- effective capability hash 为 `<base>:<skill>:<environment>`，复用既有基础 hash 解析和 SQLite Session 列，不新增 DB schema。

## Home 物化、恢复与保留

- 新 Home 为 `<dataDir>/runtime-v2/<完整 64 位 key>`。物化生成 Provider YAML、正式 patch 及完整所选 Skill bundle；复制内容 revision 校验通过后才写 ready 元数据。
- 元数据保存身份、配置 composition digest 和 lastUsedAt。相同身份且 composition/Skill 完整时复用 Home；受损或不完整 Home 改名为 `.invalid-<uuid>` 后重建，原状态保留用于诊断。
- 不复制旧 Home 的 DSH sessions/storages，也不修改 `<dataDir>/harness`。异常目录、符号链接及无有效元数据目录不自动删除；隔离的 invalid 目录暂保留，人工确认后可处理。
- SDK 新进程不能可靠恢复已有 Session；Runtime 按 Session 跟踪已运行身份。每个 context 首次进入新进程都以新 Session ID 和 SQLite 历史恢复，避免同 key 的第二个 context 被 SDK 默默创建为空会话。私聊沿用最近 30 条历史，Space 沿用完整恢复策略，成功后保存新 ID/消费游标。
- 磁盘 Home 保留时间为 7 天，保护 SQLite 引用及运行池内 Home；进程池仍沿用 10 分钟空闲 TTL 和 8 个空闲实例上限。过期清理只处理元数据有效、路径在新 namespace 内的应用目录。
- Electron 在 ready/数据初始化前获取单实例锁；重复启动退出并显示、恢复及聚焦原窗口。

## 验收

| 检查 | 结果 |
| --- | --- |
| typecheck | 通过 |
| 全量测试 | 17 文件；212 通过、3 条既有可选集成测试默认跳过 |
| Runtime V2 回归 | 7 项；身份各维度、Provider 快照、Skill 复制变化、受损重建、保留保护、同 key 私聊/Space 历史恢复 |
| build | 通过 |
| 开发 Electron 双轮真实模型 smoke | 私聊、Space、重启、编辑/删除、设置入口、正常退出通过 |
| 开发 Electron 单实例 | 两轮均验证重复进程正常退出、主进程仍可用 |
| Windows unpacked build | 通过，产物 `release/win-unpacked/MindMesh.exe` |
| 打包运行依赖闭包 | 585 runtime instances；required failures 0；72 条平台/可选依赖提示 |
| 打包 Electron 双轮真实模型 smoke | 私聊、Space、重启、编辑/删除、设置入口、两轮正常退出通过 |
| 打包 Electron 单实例 | 两轮均验证重复进程正常退出、主进程仍可用 |

可重复检查：`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm package:dir`、`node scripts/check-packaged-deps.mjs`。
真实模型 E2E 使用已有 `DEEPSEEK_API_KEY`，设置 `MINDMESH_E2E_RESTART=1`、`MINDMESH_E2E_SECOND_INSTANCE=1` 后执行 `node scripts/electron-e2e-smoke.mjs`；打包验证额外把 `MINDMESH_E2E_EXE` 设为上述产物绝对路径。脚本每次创建隔离 userData，结束后清理。

## Standards

平行审查最初发现共享 Runtime 仅恢复首个 Session 的问题；已按 Session 修复并增加回归。最终复审剩余 0 项。

## Spec

同一历史恢复问题已修复。最终复审剩余 0 项；实现维持 PR 2 范围。

两轴均无剩余发现。

## 范围与回滚

PR 3 再接 Supervisor acquire/release、starting 去重、stale/retire、lease 及定向回收。本次 Provider/workspace/删除操作仍保留原 shutdownAll 行为，不改变取消及退出业务约定。

回滚代码时保留整个 dataDir。SQLite 没有 schema 升级；旧版可使用未删除的 harness 目录，并依据历史恢复 Session。新 namespace 及 provider revision key 可保留，不必为回滚删除用户数据。
