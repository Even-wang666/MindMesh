# PR 7：Agency Agents

日期：2026-10-04。基线：PR 6 `611deba`；PR 6 已按用户授权推送到 `origin/main`。

## 内容与安装路径

Main 注册真实 `AgencyProvider`，来源固定为 [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents)。刷新先通过 GitHub SHA media type 查询 main，流式限制 80 字节并验证完整 40 位 commit；随后只下载这个 commit 的归档。模板与仓库 LICENSE 来自同一归档，不通过浮动分支逐个下载内容。

沿用已有 GitHub 下载的 32 MiB 限额和超时。归档只读，不解压、不执行脚本；检查 10,000 个 entry、256 MiB 总展开规模、普通文件类型、重复条目、64 KiB 单文件和 8 MiB 所选原文总量。受控 parser abort 通过 pipeline 拒绝，不能在异步回调中抛出未捕获异常。当前支持 18 个已核对的业务 division 的一级 Markdown 模板；忽略脚本、集成、工作流和非模板文档。YAML frontmatter 解析禁用 alias 展开，只提取名称、描述；persona 使用正文。模板中的 tools、model、权限或 command 不成为应用授权。

每个成功内容快照存为 `<dataDir>/marketplace-cache/agency/<commit>.json`，最大 16 MiB，保存原始 Markdown 和完整 MIT 许可；原子写入。PR 6 summary cache 继续保存规范化目录，刷新失败显示 stale。安装读取所选 commit 的本地内容快照，不重新解析 main；已有快照和 stale 目录可离线安装。成功的旧快照保留以支持缓存 revision；本阶段未增加自动清理。

新增固定 `marketplace:installAgent` IPC，只接受 key/revision。Main 验证类型、来源和 key 与 revision 是否仍属于当前可用目录；不接受 Renderer 传入 persona、工具、URL 或下载命令。错误返回安全消息。已安装来源直接返回已有 Agent，不因目录刷新覆盖用户改过的 persona 或配置。

市场卡片支持安装、处理中、失败重试和「已安装 · 打开」。Open 刷新本地 Agent 列表后进入现有私聊。来源状态从 SQLite 派生，不保存到远程目录缓存，因此重启和删除后不会保留错误的 Installed 状态。详情抽屉展示来源路径、完整 revision 和许可正文。

## 来源迁移与安全默认值

数据库 schema 2 → 3：增加 `agent_sources` 关联表，`agent_id` 外键删除级联，`(source, source_id)` 唯一。迁移前使用已有 VACUUM INTO 备份到 `<dbPath>.before-schema-2.sqlite`；迁移为单事务。旧 Agent、消息、插件集合和 generation 保留；`runtime_schema_version` 保持 2，不改变 Runtime 身份或 Home。

一个安装事务生成可用名称并同时写 Agent 与来源；名称冲突依次使用 `Name (2)`、`Name (3)`。来源写入失败则新 Agent 一起回滚。保存 source、sourceId、repository、revision、原始内容、license 与完整 licenseText。普通 Agent 创建/更新仅接收原有可编辑字段，不能伪造或覆盖来源。

安装默认值复用向导的共享 `DEFAULT_AGENT_MODEL`：DeepSeek 官方 / `deepseek-flash`；`skills=[]`、`tools=[]`。没有新增全局默认模型设置。未配置该 Provider 时可使用现有演示模式，用户可随后编辑模型和能力。

## 可重复检查

- `tests/agency-agents.test.ts`：真实 tar fixture、固定 commit、完整许可/原文、重启离线安装、来源去重、编辑保护、重名、删除重装、schema 2 备份和重复启动、安装事务回滚、正常私聊路径、错误输入及超大 SHA/归档受控拒绝。
- `tests/marketplace-page.test.tsx`：安装所选 revision、失败重试、Open、安装期间切换页签，保留 PR 6 loading/error/stale/键盘检查。
- `tests/app-details.test.tsx`：Installed/Open 接现有聊天视图，以及已有界面回归。
- `tests/preload-security.test.ts`：固定 install channel 与参数转发。
- `node scripts/electron-e2e-smoke.mjs --agency-agents`：真实官方目录、同 commit 条目、界面安装/Open、重复安装、空工具/技能、来源许可和 CSP/退出。随后使用现有设置入口保存仅用于测试的 loopback 自定义 Provider，编辑该 Agent 的模型，经真实 DSH/SDK 完成私聊；仅模型 HTTP 边界使用本地 fixture。设置 `MINDMESH_E2E_RESTART=1` 执行两次启动。

## 验收结果

- 最终 typecheck 与 build 通过，无新增依赖。后端针对性检查 39 项、UI 回归 66 项通过；边界修正后 Agency 7 项检查通过。
- 完整串行测试 26 个文件通过，260 项通过、3 项既有可选集成跳过。staging 约 169 秒、extended runtime 约 128 秒直接通过；本次没有 PR 6 验收中的 staging 超时。
- 官方实际目录解析 267 个模板，统一 commit `d3f71c4bb8922d3eea7576237a870dd59b3cdd52`，模板与 LICENSE 同一归档。
- 最终开发版 Electron 两次启动通过：真实目录、界面安装/Open、重复安装返回原 ID、默认空工具/技能和向导模型、来源许可持久化、用户模型修改在重启与重复安装后保留。两轮私聊均经真实 DSH/SDK 到达本地模型 HTTP fixture，请求包含安装 persona，实际回复写入 SQLite；CSP、sandboxed preload 和退出通过。测试未调用真实远程模型服务。
- 首次跨重启脚本误将已有 Open 按钮当成安装按钮，跳转聊天后继续等市场卡片而超时；修正脚本分辨 Installed 状态后，两轮完整复跑通过。产品逻辑未因这一脚本问题改动。
- Standards 审查修复 SHA 响应未限制字节的问题，并补充归档受控中止和重复 entry 拒绝；增量复审剩余问题 0、启发式问题 0。Spec 审查问题 0。
- 本阶段未重新执行 Windows unpacked/NSIS 或干净 VM 发布验收；PR 9 保留完整发布 Gate。

## 回滚

先退出应用，保存整个 dataDir 和当前 schema 3 数据库。PR 6 不接受 schema 3，不能只切代码或修改 schema_version。需要回退时使用迁移前的 `.before-schema-2.sqlite` 恢复数据库，并保留 schema 3 原库供再次升级；迁移后的新 Agent/消息不在旧备份中。聊天/插件/Skills/Runtime 文件不手动删除或复制 Session。恢复后再启动 PR 6，避免将新库的 WAL/SHM 与备份混用。本阶段仅 PR 6 已推送；PR 7 代码和验收记录保存本地。
