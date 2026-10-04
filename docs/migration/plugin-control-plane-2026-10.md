# PR 4：Plugin 控制面与 staging

日期：2026-10-04。基线：PR 3 `359d85c`。PR 4 只提供显式开发者入口；正式聊天接入 enabled 插件由 PR 5 完成。

## 数据与提交路径

`MindMeshDatabase` 集中执行版本化迁移：旧库（无版本）→ schema 1 的既有表/列 → schema 2 的 `installed_plugins`、`plugin_set_generation`、artifact 元数据。迁移在 `BEGIN IMMEDIATE` 事务内完成；未来 schema 拒绝启动。现有 Agent、Space、消息和 Session 不删除。

迁移前以 SQLite `VACUUM INTO` 生成 `<数据库路径>.before-schema-<旧版本>.sqlite`，包含 WAL 中已提交的数据。重复启动不重复迁移。备份保留在本机。

`PluginSetManager` 从数据库读取完整 desired state。revision 包含按包名排序的包名、确切版本、enabled 和规范化 config；不含时间戳、目录和日志。`PluginManager.change()` 串行执行 install/update/remove/enable/disable；提交使用 generation 条件检查和一个 SQLite 事务。失败、取消或并发旧快照均不改变当前集合。

## Staging gate

每次变更新建 `<dataDir>/plugin-staging/<uuid>/home` 与空 workspace。子进程环境仅注入系统必需变量、隔离 Home、占位模型凭据和关闭遥测；不读取真实 Provider key、用户 Skill、persona 或项目 `.env`。

1. DSH `--profile sdk --dump-config` 初始化全新 SDK profile。
2. 用 DSH 公开 `runCli({ packageManager })` 参数调用随包 pnpm 11.7.0；只接受 npm 包名和确切版本，传递 `--save-exact --ignore-scripts`，关闭自动 peer 安装。
3. 检查确切版本和 bundle manifest，检查整个新增安装树中的安装/prepare 脚本和 `binding.gyp`；需要 build approval 即拒绝，不批准或执行。在隔离子进程中调用 DSH 的实际 runtime resolution，结合 Node 本地解析检查 required peers（含 Cordis 和第三方包）的存在性和版本；DSH 安装自带的 fallback peers 不被误判为缺失。
4. 再次 dump 完整配置，检查 YAML 和重复 entry ID。使用生产 `prepareAgentCapabilities()` 生成正式 patch，覆盖文件、Shell、网页、待办、目标、后台任务和子代理；不装用户 Skill，保持 `tool-plugin-manager` 关闭。浏览器依赖平台安装状态，未放入这个固定组合。
5. 严格检查 SDK stdout 的 JSON-RPC framing，再使用真实 `DeepSeekHarness.start()` / `close()` 握手。DSH 的可选 entry 未激活警告也视为失败。仅握手通过不能证明每个工具可调用；真实插件工具调用在 PR 5 验收。
6. 确认启动没有改变 manifest/lockfile/workspace/profile patch；保留 declarative artifact，检查取消，再事务提交 desired state 和 artifact 引用。

Artifact 位于 `<dataDir>/plugin-artifacts/<uuid>`，包含 profile manifest、exact lockfile、pnpm workspace、profile patch、规范化 dump、正式能力 patch 和 runtime/package manifest digest。它不含 live Home、Session 或 storage。PR 5 应以 frozen lockfile 重建，并对照 runtime、resolution 和 composition 验证；不能改为按最新版本重新解析。

失败结果与日志仅留本机。子进程有 120 秒上限、取消、4 MiB 输出限制，内存摘要有界；错误摘要最多 4096 字符并脱敏。Windows 超时/取消使用受控 PID 的 taskkill tree，并等待退出。七天清理仅处理 staging 根下 UUID 实目录；artifact 仍保留供当前集合和后续 PR 5 使用。

独立 DSH_HOME 是兼容环境，不是 OS sandbox。staging 会执行插件 JavaScript；当前开发者入口应只测试已审核的插件包。

## 开发者入口

主进程识别 `--plugin-dev=<绝对请求文件路径>`，完成操作并退出，不创建窗口、不注册插件 Renderer IPC。请求示例：

```json
{
  "dataDirectory": "C:/Temp/mindmesh-plugin-test",
  "resultFile": "C:/Temp/plugin-result.json",
  "change": {
    "kind": "install",
    "packageName": "your-reviewed-plugin",
    "version": "1.0.0"
  }
}
```

省略 `change` 只读取集合。remove/enable/disable 不传 version。支持的来源是 npm registry；开发测试额外支持 `fixtureRegistry`，只允许 `http://127.0.0.1:<port>/`，不开放任意远程 URL、tarball、git 或 shell 参数。

开发版：`pnpm build` 后 `node scripts/plugin-smoke.mjs`。打包版设置 `MINDMESH_PLUGIN_SMOKE_EXE` 为 `release/win-unpacked/MindMesh.exe` 后运行同一脚本。测试启动隔离用户目录和本地 npm registry；子进程 PATH 不含外部 pnpm。

## 验证

- `tests/plugin-set.test.ts`：旧库数据保留、备份内容、重复启动、未来 schema 拒绝、revision 与 generation 条件提交。
- `tests/plugin-runner.test.ts`：环境凭据排除，真实子进程超时和取消。
- `tests/plugin-staging.test.ts`：真实 exact 安装与 SDK 初始化、启停更新删除、stdout 污染、启动失败、直接/间接安装脚本、重复 ID 和多插件冲突、在途取消、串行队列。失败后数据库集合保持原值，安装脚本 marker 不出现。
- `scripts/plugin-smoke.mjs`：实际开发版/Windows 包、没有外部 pnpm 时安装、重启读取、disable/enable。
- Windows CI 增加打包插件 smoke；依赖检查也检查 pnpm 版本、CLI、dist 和许可文件。

全量测试：21 个文件通过，237 项通过、3 项既有可选集成跳过。typecheck、build 和 DSH dependency matrix 通过（34 项直接依赖、533 个运行实例、缺失 0）。两路代码审查发现并修复日志写入异常逃逸和 required peer 校验缺漏；Standards 增量复审剩余硬规范/启发式问题均为 0，Spec 增量复审剩余问题为 0。

最终 Windows unpacked 构建通过；打包依赖检查覆盖 585 个运行实例，required failures 为 0，pnpm 版本/CLI/dist/许可及 resolution probe 资源存在。开发版与最终打包版均在仅含 Windows System32 的 PATH 下完成真实插件安装、跨进程重启读取与 disable/enable；没有外部 pnpm 参与。最终打包版 Electron sandbox/CSP 冒烟通过。测试结束后按隔离 staging/smoke 目录标记检查进程，未发现残留 Node/Electron/MindMesh 子进程。

## 回滚

关闭所有 MindMesh 进程，保留当前数据库、同名 `-wal`/`-shm` 和整个 dataDir 作为恢复点。需要回到 PR 3 时，用 `before-schema-0.sqlite` 备份替换目标数据库，并移走目标的 `-wal`/`-shm` 后再启动旧版。备份后的聊天或配置变化不在旧备份中；不要直接降低 `schema_version`。plugin-staging 和 plugin-artifacts 是新目录，旧版不读取它们。
