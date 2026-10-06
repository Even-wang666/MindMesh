# Phase 3：Run Outputs & Artifacts

实施日期：2026-10-06。范围依据《MindMesh-合并修正版实施路线图》Phase 3 和 §4.6，代码起点为 `77627a4`。

## 实现

- schema 11 增加 artifacts 表。Execution 是必填归属；Conversation 从 Execution 推导，Run / Agent 可空，支持协作级成果和单 Run 成果。
- 同一归属下按路径去重。一个 Run 先创建再修改同一文件时，保留“新建文件”分类；不同 Run / generation 的成果记录独立保留。
- DSH `write` / `edit` 的已配对成功工具结果产生文件变更证据，再验证文件路径并持久化。错误、悬空调用、读取结果和 Agent 文本声明不会生成 Artifact。
- 事件配对继续使用 Run / 原生 Session / callId；文件路径从完整工具确认提取，工具预览仍执行脱敏和截断。
- 回复展示“本轮成果”；Space 按 Execution 和 Agent 展示“本次协作成果”。没有回复消息的中断 Run，以及没有 Run 的协作级成果，也能独立展示。
- 复用 Phase 2 的回答版本过滤，默认展示最新代；浏览旧代时切换对应成果记录。归档和重启保留成果记录，作者归属优先读取冻结的 Run 快照。
- “在文件夹中显示”只接受已保存的 Artifact ID，并在 Main 重新检查文件。客户端不能传任意文件路径；不自动打开或执行文件。
- 对话/Agent/Space 删除仅级联清理成果元数据，不删除物理文件。

## 验证

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm smoke:electron
pnpm smoke:security
pnpm smoke:plugins
$env:MINDMESH_E2E_RESTART='1'
node scripts/electron-e2e-smoke.mjs --artifacts
```

`--artifacts` 使用隔离用户目录和当前 DeepSeek 测试凭据，验证真实 write 创建、edit 修改、Run 归属、双 Agent 协作成果、Electron 界面和重启后的持久化；测试退出后清理临时目录。

针对性测试：`tests/artifacts.test.ts`、`tests/artifact-security.test.ts`、`tests/artifact-ui.test.tsx`、`tests/runtime-event.test.ts`、`tests/preload-security.test.ts`。覆盖 schema 10 升级备份、记录归属/去重、跨 Execution Run 拒绝、Execution-only 成果、Session 配对、版本过滤、路径边界和定位错误。

2026-10-06 验收结果：完整测试 49 个文件通过，428 项通过、3 项原有跳过；typecheck、lint、build、smoke:electron、smoke:security、smoke:plugins 均通过。最终版本的真实 Artifact Electron 测试两轮重启通过。

## Standards 规范审查

路径检查的 UNC workspace 边界已修复；回归测试证明拒绝发生在文件系统访问前。目录联接/符号链接也在遍历目标之前拒绝。复核无剩余规范问题。

## Spec 需求审查

写入接口已补齐 Execution-only 成果，Conversation 自动推导，Run/Agent 可空，并验证跨 Execution 的 Run 不得用于归属。复核无剩余需求偏差。

两轴最终未解决问题均为 0。

## 已知边界

- 当前自动识别内置 write/edit 的真实确认格式。Shell 或其他插件尚无统一的文件变更证据；不扫描整个工作目录，也不从任意 stdout 或“已保存”文案猜测成果。后续按真实协议增加专用 adapter。
- 保存历史成果记录，不复制历史文件内容；同一路径后来被覆写时，旧记录仍指向当前物理文件。
- MIME 类型依据扩展名推断。不存在的文件、目录、URL、UNC 路径及经过符号链接/目录联接的路径不接受为可定位成果。
- schema 10 升级前自动生成 `.before-schema-10.sqlite` 备份。回退时关闭应用并恢复该备份；物理成果文件不受数据库回退影响。

没有新增依赖。Phase 3 的改动只保存在本地；Phase 2 的 `77627a4` 已推送到 origin/main。
