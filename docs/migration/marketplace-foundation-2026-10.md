# PR 6：Marketplace 基础

日期：2026-10-04。基线：PR 5 `d6fd004`。

后续：PR 6 `611deba` 已按用户授权推送到 `origin/main`；PR 7 接入真实 Agency provider 和安装/Open，见 [Agency Agents 验收](./agency-agents-2026-10.md)。本页保留 PR 6 验收范围。

## 范围与运行路径

新增「市场」一级导航入口和智能体、团队、插件三个页签。Renderer 仅调用 `window.mindmesh.marketplace.list(kind, refresh)`；Preload 使用固定 `marketplace:list` channel，Main 校验目录类型和 refresh 布尔值。不接受 Renderer 指定的 URL、包命令或 provider 回调。

共享契约位于 `src/shared/marketplace.ts`。条目身份为 `(kind, source, sourceId)`，key 使用 JSON 元组，提供往返解析，不依赖分隔符拆字符串。Main 的 provider 固定来源，远程条目只能提供 sourceId、名称、描述、revision 和 license；命令和任意额外字段被丢弃。字符串限长、清理控制字符，非法条目跳过，同来源重复 ID 去重；跨来源同 ID 保留。Renderer 以普通文本展示字段。

`MarketplaceCatalogService` 按目录去重正在执行的查询，将规范化快照原子写入 `<dataDir>/marketplace-cache/<kind>.json`。15 分钟内复用成功缓存；强制刷新绕过时效检查。重启后重新校验缓存字段并重建 key，损坏缓存忽略。刷新或写盘失败时保留上次成功快照并返回 stale；无快照时返回安全 error，不暴露原始异常。成功重试替换缓存。

界面覆盖 loading、空目录、error、stale 说明和更新时间；可刷新重试，快速切页时丢弃旧页签响应。页签支持方向键、Home/End 和焦点切换。

默认注册 agency / mindmesh-curated / dsh 三个来源的空 provider。本次没有远程内容或安装按钮；真实 pinned Agency 内容、Team manifest 和 DSH catalog adapter 分别属于 PR 7、8、9。现有 Skill/Tool 页面保留。未变更 Runtime、插件 desired state、数据库 schema 或依赖。

## 可重复检查

- `tests/marketplace.test.ts`：key 往返与来源隔离、恶意/非法字段规范化、跨来源目录、持久缓存及重启、stale/retry、并发去重、非法查询和损坏缓存。
- `tests/marketplace-page.test.tsx`：loading/empty、三个页签、强制刷新、键盘操作、旧响应丢弃、文本渲染、stale 和 IPC 错误重试。
- `tests/preload-security.test.ts`：固定 IPC channel 和查询参数转发。
- `node scripts/electron-e2e-smoke.mjs --security-only`：无密钥真实 Electron 导航、三个页签、Main/Preload 查询、非法 kind 拒绝、sandboxed preload、CSP 和退出。

## 验收结果

- 最终 `corepack pnpm typecheck`、`corepack pnpm build` 通过；无新增依赖。
- 首轮针对性检查 4 个文件、72 项通过，包含现有 60 项界面回归。审查修正后 Marketplace/Main/Preload 针对性检查 3 个文件、13 项通过。
- 全量 `corepack pnpm exec vitest run --fileParallelism=false`：24 个文件通过、249 项通过、3 项既有可选集成跳过；1 个既有 plugin-staging 用例触发 240 秒超时。extended runtime 真实插件集成约 181 秒通过。随后单独复跑 `tests/plugin-staging.test.ts`，未修改阈值或断言，约 199 秒通过。不能将首轮记为全绿；本次所有未跳过用例均已得到通过结果。
- 开发版真实 Electron 无密钥冒烟通过：市场导航、三个页签、受控查询、非法 kind 拒绝、sandboxed preload/CSP 和正常关闭。未在本阶段重新执行 Windows 打包/NSIS 或真实远程目录验收。
- Standards 审查修复两项：多来源合并目录超过 2,000 条时重启缓存上限不一致，以及 tabpanel 缺少键盘焦点入口；增量复审剩余问题 0，启发式问题 0。Spec 审查问题 0。

## 回滚

本阶段无数据库迁移。退出应用后可回到 PR 5；新增目录缓存只保存展示数据，可保留或单独移除，不影响聊天历史、已安装插件、Skills 或 Runtime Home。代码与记录仅保存本地。
