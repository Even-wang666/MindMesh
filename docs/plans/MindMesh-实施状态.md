# MindMesh 实施状态

更新日期：2026-09-22

## 已完成

- 项目内 Conda Python 3.11 环境。
- DeepSeek Harness 源码浅克隆与精确提交记录。
- Electron + React + TypeScript + Vite 基础工程。
- 方案 B 代码化 SVG 标志与锁定四色设计 Tokens。
- 本地 SQLite 数据表：Agent、Space、成员、消息、Runtime Session 快照。
- Agent 创建四步向导、Agent 管理列表与详情抽屉。
- Agent 私聊、Space 共享对话、`@Agent` 自动补全和顺序执行。
- Skills、Tools、Settings 与 Runtime 状态页面。
- DeepSeek Harness SDK Adapter、按完整 Agent 能力配置哈希划分的运行池。
- DeepSeek Harness SDK 子进程握手与正常回收 PoC。
- `ELECTRON_RUN_AS_NODE=1` 的 Electron 子进程启动路径及 packaged dsh 入口解析。
- 未配置密钥时的安全演示模式。
- Settings 模型服务配置与 Electron safeStorage API Key 加密保存流程。
- ContextBuilder 和 MentionParser 单元测试。
- Windows unpacked 构建与启动冒烟测试。
- 方案 B 的 SVG、PNG、ICO 正式应用图标。
- 修复 packaged Electron 未包含 Harness SDK peer dependencies 导致的 `ERR_MODULE_NOT_FOUND`；新产物已完成带日志启动验证。
- 持久化 Harness Session ID、Agent 配置快照和每个 Agent × Space 的 `lastConsumedMessageSequence`；Space 只注入未消费的共享消息。
- 将 Harness `assistant/message` 通知映射到聊天界面，并修复发送中按 Enter 清空草稿的问题。
- 使用当前设备配置的 DeepSeek API Key 完成一次真实 SDK 模型请求；未在仓库中保存密钥。
- 验证 SDK 新进程无法直接恢复已存在的 Session ID；应用遇到该明确错误时创建新 Session，并从 SQLite 最近消息补足上下文。
- 完成开发版和 Windows unpacked 包的真实 Electron 界面私聊、双 Agent Space 协作与窗口关闭冒烟测试。
- 同一隔离数据目录下重启 Windows unpacked 包后，两轮真实私聊和双 Agent Space 协作均成功；历史私聊保留，退出后无残留测试 Harness 子进程。
- 修复打包版 Harness 子进程缺少间接 peer 包：固定运行时依赖版本，解包 Node 依赖，并增加打包依赖检查。
- 设置页支持修改本地用户昵称和头像；聊天 Markdown 排版、Space 背景编辑已完成。
- Agent 删除需确认，Space 名称、简介、背景和成员可编辑；SQLite 更新在同一事务中完成，失败时回滚并保留历史消息。
- 数据库和界面测试覆盖 Space 成员增删、Agent 删除及删除最后一个 Agent 后重启；完整测试、类型检查和构建通过。
- Windows NSIS 安装包成功生成并静默安装到临时目录；安装版真实私聊、双 Agent Space 协作和连续两轮重启验证通过，历史消息保留且无残留 Harness 子进程；静默卸载成功。
- Electron CDP 端到端脚本增加 Space 编辑和 Agent 删除界面操作，已在真实 Electron 进程通过。
- Space 删除入口已完成确认交互；SQLite 同一事务清理该空间的成员、消息和运行会话，其他空间及私聊保留。删除最后一个 Space 与 Agent 后重启不会重新生成默认数据。
- Skill 页面从本地技能目录读取已安装的 `SKILL.md`；Agent 选择的技能被复制到独立 Harness 技能根目录，所选工具通过 SDK 启动补丁启用，未选中的内置工具关闭。
- 新增脱敏运行错误 JSONL 日志，仅记录时间、范围、Agent ID、已知错误类型和安全代码，不记录提示词、原始错误消息或密钥。
- 新增跨 Space／私聊隔离、双 Provider 启动路由、能力补丁与删除范围测试。真实 DeepSeek SDK 已使用选中的“文件”工具读取随机标记，并从 Skill Registry 加载自定义技能返回技能正文中的隐藏标记；Windows unpacked 包的真实对话及 Space 删除界面通过，运行依赖检查缺失 0 项。
- 设置页可通过系统文件夹选择器指定 Agent 工作目录，路径保存于 SQLite；切换目录会关闭旧 Harness 进程并重建运行会话，聊天消息保留。真实 DeepSeek 文件工具已在指定临时目录完成读取、创建和写入；选中的 Shell 工具也通过 PowerShell 读取了随机标记文件。Electron 界面冒烟覆盖设置入口。

## 下一阶段

- 将现有 Electron CDP 端到端冒烟脚本纳入稳定的发布检查。NSIS 安装版首轮真实请求曾返回一次通用失败提示，随后单轮及连续两轮重启测试均通过；如再次发生，先读取 `mindmesh-data/runtime-errors.jsonl` 的脱敏错误代码定位来源。
- 使用第二个真实模型服务的凭据完成跨 Provider 请求验收；当前只配置了 DeepSeek Key，双 Provider 的配置路由已有确定性测试覆盖。
- SDK 暂无可供桌面应用直接列举工具 Registry 的接口；工具页当前展示受 MindMesh 支持的三个内置工具，实际启用状态由 Harness 补丁控制。
- Space 删除目前清理 MindMesh SQLite 记录；Harness SDK 的底层会话文件没有删除接口，后续需在 SDK 提供安全删除能力时补上物理清理。
- 当前 SDK 只在完整 `assistant/message` 事件中提供文本；token 级流式输出需等待 SDK 协议支持，跨进程继续原 Harness Session 也需 SDK 提供恢复入口。
