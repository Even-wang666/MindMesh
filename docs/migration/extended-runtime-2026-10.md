# PR 5：Extended Runtime 接入

后续：PR 6 Marketplace 基础已接入独立目录查询与界面，见 [Marketplace 基础验收](./marketplace-foundation-2026-10.md)。本页仍记录 PR 5 Runtime 验收。

日期：2026-10-04。基线：PR 4 `166de60`。

## 运行路径

正常启动将数据库中的 `PluginSetManager` 接到 Harness Adapter。每次 full 请求捕获 enabled 集合、确切版本、配置和已验证 artifact 的冻结快照。enabled revision 与 artifact digest 只进入 extended 身份；插件变更不改变 chat/workspace 的身份。

正式 Home 在 `runtime-v2/<identity key>` 中异步重建。读取 `plugin-artifacts` 下的实目录和普通文件，核对完整 artifact digest、desired revision、enabled 集合、DSH 与 pnpm 版本。旧 PR 4 artifact 没有 registry 字段时使用 npm；新 artifact 同时封存验证来源，只允许 npm 和测试用 loopback registry。

复制 manifest、lockfile、workspace 和 profile patch，用随包 pnpm 11.7.0 执行 frozen install，禁止安装脚本与自动 peer 安装。重建后检查整个安装树的 manifest digest、build scripts 和实际 DSH resolution/peers；以固定完整能力 patch 对照 staging 的 dump，再对实际 Agent patch 做 dump 和严格 JSON-RPC 初始化。Windows 路径与 staging Home 被规范化，配置比对不依赖 dump 注释。

只有所有检查成功、安装输入和代码未被探测启动改变、应用 patch/Provider 输入/选中 Skill 未改变时才写 ready metadata。复用 Home 会校验安装代码与 pnpm 链接；损坏 Home 被改名保留，再从封存配方重建。不会复制旧 Home 的 Session、storage 或其它运行状态。

chat/workspace 不读取或安装插件 artifact，复用时拒绝额外 bundle/dependency/profile patch；workspace 继续关闭 Shell。full 没有 enabled 插件时也使用独立身份，但 profile 保持核心组合。

DSH 0.2 的旧 `settings.yaml` 启动时会被迁移、改名并修改 profile。现在 Provider 非敏感输入放在 `provider-settings.yaml`，通过应用能力 patch 传入；真实凭据仍只在正式 SDK 启动环境注入。物化的 pnpm、dump 和协议探测仅使用隔离环境与占位凭据。

## Generation、历史与失败

插件提交后仅 extended 实例 stale。旧 lease 可以完成，释放后回收；下一次 full 请求按新身份创建 Home/SDK/Session。独立开发者进程改变数据库时，Adapter 在下一次 full prepare 中检测 revision。已有 PR 3 Session 条件写回防止旧请求覆盖新 Session ID；私聊和 Space 继续由 SQLite 补注入历史。

停止与退出会取消正在物化的安装子进程，并等待其退出。失败不修改 desired state、不写 ready；Home 留下 `materialization-failure.json`，安装/解析/dump/协议日志位于同级 `plugin-diagnostics`。界面继续使用 materialization 分类并提示可切回仅对话或工作目录；修复、disable/remove 后可以重试。

## 可重复检查

- `tests/plugin-runtime.test.ts` 使用真实 SQLite、pnpm、DSH 和插件 JavaScript；仅模型 HTTP 边界使用本地 OpenAI 兼容 fixture。检查真实工具 marker、core 物理隔离、冻结 lockfile、在途更新、私聊/Space 历史、新 Session 条件写回、重启、代码损坏重建、配方损坏后 core 可用、恢复重试、移除和取消准备。
- `tests/runtime-v2.test.ts` 检查插件 revision 只影响 full；现有 Supervisor/Services 测试继续覆盖共享 lease、退出、失败、Space 游标和历史恢复。
- `tests/plugin-runtime-integrity.test.ts` 检查安装树不变时，pnpm alias 重定向仍会改变完整性摘要；Session 文件不参与摘要。
- `pnpm smoke:plugins` 在真实 Electron 开发版中安装/启停、调用插件工具、重启、更新、移除，PATH 仅含 System32。
- 设置 `MINDMESH_PLUGIN_SMOKE_EXE` 为 Windows unpacked 的绝对可执行路径，运行同一脚本检查随包 pnpm 和正式 extended Home。

开发者入口新增可选 `runtime: { permission: "full", baseUrl: "http://127.0.0.1:<port>/v1" }`，只接受 loopback 模型 fixture。它没有新增 Renderer IPC 或 Marketplace 界面。工具动态发现与 per-Agent plugin ACL 仍在范围外。

## 回滚

本阶段没有数据库 schema 迁移。退出应用并保存整个 dataDir 后可回到 PR 4；PR 4 不加载这些 extended 插件 Home。当前数据库中的插件集合与聊天历史保持有效，旧版可继续使用核心对话。不要手动复制 Home 的 Session 或降低数据库 schema。PR 5 再启动时会检测旧 Provider 配置布局并重建 Home，历史仍从 SQLite 恢复。

## 验收结果

- 最新 typecheck 与 build 通过；DSH 依赖检查覆盖 34 项直接依赖、533 个运行实例，required failures 为 0。
- 全量串行测试通过：23 个文件、240 项通过、3 项既有可选集成跳过。首次并发测试与打包同时运行时，旧 staging 用例超过 240 秒；改为不并行打包的串行复跑，该用例约 154 秒通过，PR 5 集成约 101 秒通过。
- 开发版 Electron 在只含 System32 的 PATH 下通过 install、restart、disable/enable、真实插件工具调用、core 物理隔离和 update/remove。
- Standards：硬规范问题 0、启发式问题 0；链接目标校验补充的增量复审仍为 0。
- Spec：缺漏/实现错误/范围扩大 0；链接目标校验补充的增量复审仍为 0。

- 最终 Windows unpacked 构建通过；检查覆盖 585 个运行实例，required failures 为 0，随包 pnpm 与 resolution probe 可用。直接检查最终 asar，确认包含链接目标完整性校验。
- 最终打包版在只含 System32 的 PATH 下通过 install、restart、disable/enable、真实插件工具调用、core 物理隔离和 update/remove；没有外部 pnpm 参与。模型服务使用本地 fixture，插件工具由真实 DSH 执行并写入实际调用 marker。
- 最终打包版 Electron sandboxed preload/CSP 冒烟通过。
