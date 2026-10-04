# MindMesh 实施状态

更新日期：2026-10-04

## 已完成

- 下一阶段 PR 1A 基线与 PR 1B DSH `0.2.0-rc.2` 升级已完成，详见 `docs/migration/` 验收记录。
- PR 2 Runtime V2：显式权限与 schema/DSH/Skill/Provider/workspace revision、冻结运行快照、新 namespace 的独立 Home 物化、逐 Session 历史恢复、七天磁盘保留和 Electron 单实例锁。详见 [Runtime V2 验收与迁移](../migration/runtime-v2-2026-10.md)。
- PR 3 Runtime Supervisor：starting 去重、acquire/release、stale/retire、按 Provider/context/request 定向回收、安全错误诊断及 Session 条件写回。详见 [Supervisor 验收](../migration/runtime-supervisor-2026-10.md)。
- PR 4 Plugin 控制面与 staging：版本化 SQLite migration 与备份、插件 desired state/generation、串行全集合验证、随包 pnpm、真实安装/dump/SDK 初始化、required peer 检查及仅开发者入口。详见 [Plugin 控制面验收与回滚](../migration/plugin-control-plane-2026-10.md)。

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
- Windows 安装器已升级为无标题栏、圆角的一键中文品牌界面：用户协议与隐私政策改为按需打开的本地文档，安装目录可在主界面直接更改，进度页使用 Iris → Mint 渐变并隐藏原生导航按钮，完成后自动启动 MindMesh。最终安装路径超过 49 个字符时交互页禁止继续，静默安装返回错误码 87，避免深层 Harness 依赖解包不完整。
- Electron CDP 端到端脚本增加 Space 编辑和 Agent 删除界面操作，已在真实 Electron 进程通过。
- Space 删除入口已完成确认交互；SQLite 同一事务清理该空间的成员、消息和运行会话，其他空间及私聊保留。删除最后一个 Space 与 Agent 后重启不会重新生成默认数据。
- Skill 页面从本地技能目录读取已安装的 `SKILL.md`；Agent 选择的技能被复制到独立 Harness 技能根目录，所选工具通过 SDK 启动补丁启用，未选中的内置工具关闭。
- 新增脱敏运行错误 JSONL 日志，仅记录时间、范围、Agent ID、已知错误类型和安全代码，不记录提示词、原始错误消息或密钥。
- 新增跨 Space／私聊隔离、双 Provider 启动路由、能力补丁与删除范围测试。真实 DeepSeek SDK 已使用选中的“文件”工具读取随机标记，并从 Skill Registry 加载自定义技能返回技能正文中的隐藏标记；Windows unpacked 包的真实对话及 Space 删除界面通过，运行依赖检查缺失 0 项。
- 设置页可通过系统文件夹选择器指定 Agent 工作目录，路径保存于 SQLite；PR 3 起切换目录会使旧实例 stale，在途请求完成后回收，后续请求使用新 Session，聊天消息保留。真实 DeepSeek 文件工具已在指定临时目录完成读取、创建和写入；选中的 Shell 工具也通过 PowerShell 读取了随机标记文件。Electron 界面冒烟覆盖设置入口。
- 模型服务设置支持 DeepSeek、Kimi、OpenAI、Anthropic、MiniMax、智谱、通义千问和阶跃星辰八家预置服务，以及一个 OpenAI 兼容自定义服务；确定性测试覆盖路由和配置。DeepSeek 与 Kimi 已完成真实 API 请求验收，Kimi 目录更新为当前可用的 K3 与 K2.6；Electron 双轮重启测试覆盖 Kimi 私聊及 Kimi → DeepSeek 的 Space 顺序协作。
- Kimi K3 已完成 Windows unpacked 与 NSIS 安装版发布验收：真实私聊、Kimi → DeepSeek Space 双轮跨重启、界面编辑/删除、正常退出及静默卸载全部通过。Harness 单轮输出上限提升至 8192，空正文不再静默持久化；Electron 冒烟测试改为断言实际消息正文，并支持失败时保留隔离用户目录。
- DeepSeek Flash 对话支持 PNG、JPEG、WebP、GIF 图片输入，主进程会校验格式、签名及 32 MiB 总大小；设置页支持查询 DeepSeek 余额。
- 工具目录现支持网页搜索、文件、Shell、浏览器、待办清单、目标管理和后台任务七项能力，实际启用范围由 Agent 配置与当轮权限共同限制。
- Harness 子进程环境按系统变量白名单和当前 Provider 最小化注入；对话默认使用仅对话权限，用户消息限制为 64 KiB UTF-8；退出时等待当前发送和 Harness 回收后再关闭数据库。
- CI 保留 Ubuntu 类型检查、测试和构建，并增加 Windows unpacked 打包依赖检查与无密钥安全冒烟。

## 下一阶段

- 按执行规划进入 PR 5 Extended 接入：full 权限加载已验证的 enabled 插件集合；chat/workspace 的 profile 物理不含第三方插件；打通 generation/session 切换、失败恢复及真实插件工具调用。

- 使用各服务的独立测试凭据继续验收 OpenAI、Anthropic、MiniMax、智谱、通义千问、阶跃星辰及自定义 OpenAI 兼容服务；当前 CI 已纳入无密钥安全冒烟，带密钥的模型请求仍由发布前人工验收。
- SDK 暂无可供桌面应用直接列举工具 Registry 的接口；工具页当前展示受 MindMesh 支持的七项工具，实际启用状态由 Harness 补丁控制。
- Space 删除目前清理 MindMesh SQLite 记录；Harness SDK 的底层会话文件没有删除接口，后续需在 SDK 提供安全删除能力时补上物理清理。
- 当前 SDK 只在完整 `assistant/message` 事件中提供文本；token 级流式输出需等待 SDK 协议支持，跨进程继续原 Harness Session 也需 SDK 提供恢复入口。
