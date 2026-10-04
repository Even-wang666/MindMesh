# Marketplace 展示补齐与独立 Windows 发布验收

日期：2026-10-04。基线：`acb9e46`（用户要求先将原有两份 review 文档提交并 push）。用户另已授权将本轮改动 push，并采用 GitHub Actions 全新 Windows VM 验收。

## 展示补齐

Agent 卡片增加 Agency division 分类和免费标记；原生 search input 同时匹配名称、用途和分类，分类 select 与搜索组合筛选，切换页签清空条件，无结果明确提示。Agency 老缓存从来源路径恢复分类。类别最多 80 字符，保持数据字段规范化。

Team 卡片增加成员数量与成员预览。预览由本地 curated manifest 的成员引用生成，只是展示信息，不改变安装清单、团队 revision、事务或成员顺序。字符串最多 160 字符、最多 20 个成员；旧 curated summary 缺少预览时重新读取本地 provider，再缓存完整展示数据。

## CI 既有失败与修复

读取 `acb9e46` 对应 CI 的实际任务日志：Windows package 在 `electronDist` 不存在时失败；Ubuntu capability test 在请求浏览器 patch 时收到明确的 Chromium 不可用错误。首次尝试增加 Electron build 许可，远程任务仍在同一位置失败；核对实际 Electron 44 package 后确认它已没有 postinstall，构建 job 还必须显式执行官方 `install-electron` CLI。保留已受信 Electron 的构建许可以满足 pnpm 的依赖状态检查，不开放第三方插件 build scripts。浏览器 availability 当前仅支持 Windows Edge，测试现对不可用环境断言错误，保留可用环境中 MCP 插入及会话工具的完整断言。不新增 Linux 浏览器产品支持。

## 独立安装验收

构建 job 生成 NSIS，明确 `--publish never`，只上传七天留存的测试 artifact。`windows-clean-install` 是独立的 `windows-latest` job，下载该 NSIS 后安装到短路径，不执行项目依赖安装。GitHub 托管任务每次使用新 VM，见 [官方 runner 说明](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)。它是干净的应用安装环境，包含 runner 的预装系统/测试工具，并非消费版 Windows 的裸 OS 镜像。

测试 harness 只安装固定版本 `tar` 以生成 fixture，不含 Electron、DSH 或 pnpm；已安装应用从自身资源运行。应用和测试进程 PATH 只含 Windows System32，并断言外部 pnpm 不可解析。沿用真实 DSH/SDK/插件 JavaScript，仅模型 HTTP 使用 loopback fixture。

安装版依次执行 Agent/Team/Plugin 的界面双轮重启验证，以及插件 full 实际工具调用、chat/workspace 物理不含第三方插件、更新/移除、启停、取消与失败保护。Agent/Team smoke 同时检查新搜索/分类/免费和成员展示。最后 always 静默卸载并检查主程序移除。

## 结果

完整本机串行测试 31 个文件通过，299 项通过、3 项既有可选集成跳过。typecheck、format/lint、build、DSH 依赖检查通过。Standards 硬规范/启发式问题 0，Spec 代码缺漏/错误/范围扩大 0；远程独立 VM Gate 仍等待实际结果。

本机 Agent/Team 的真实 Electron 双轮展示、安装/Open、实际 DSH 对话、状态/用户编辑保留及 sandbox/CSP 验证均通过。远程独立 VM 任务尚在执行。最终 run URL/结论在验收结束后补记；不能以 workflow 已配置代替实际通过。
