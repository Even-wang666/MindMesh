# MindMesh 项目评估与开发准备计划 V1.0

## 评估结论

- 当前项目只有产品、架构和代码实现文档，尚无 Git 仓库、源码、依赖、测试或构建配置。
- 产品范围清晰：Windows 本地单用户桌面端，支持 Agent 创建、私聊、Space、`@Agent` 顺序协作。
- DeepSeek Harness 是最大技术风险。其仍处于 developer preview，必须固定精确版本并通过 PoC 后再进入正式开发。
- 产品、领域模型、数据库、IPC 和 UI 统一使用 `Space`，不再使用 `Workplace`。
- 官方 TypeScript SDK 使用子进程与 stdio JSON-RPC；现有设计文档中的 HarnessAdapter 伪接口需要按实际 SDK 重写。
- MVP 采用 SDK 运行池：按 `provider + model + Agent 能力配置哈希` 复用 Harness 子进程。

## 环境与仓库准备

1. 初始化 Git、pnpm monorepo、Electron、React、TypeScript、Vite、Drizzle、SQLite、Vitest 和 Playwright。
2. 使用原生 Windows 开发环境；固定 Node 24 与 `pnpm@11.7.0`。
3. 安装 Visual Studio 2022 Build Tools、Desktop development with C++ 和 Windows SDK。
4. 查询 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-sdk-client` 共同发布的精确版本，禁止使用浮动 `latest`。
5. 将对应源码浅克隆到 `.references/deepseek-harness` 并加入 `.gitignore`；记录版本和 commit SHA，但正式依赖使用 npm 包与锁文件。
6. Harness 状态写入 Electron `userData` 下的独立目录；API Key 使用 Electron `safeStorage`，不得写入 SQLite、日志、IPC 或 Git。

## Harness PoC 门槛

正式 UI 开发前必须完成：

1. 普通 Node 进程通过 TypeScript SDK 完成一次请求并接收流式事件。
2. 两个不同 runtime key 能使用不同模型，Session 完全隔离，进程可正确关闭。
3. Electron main 能运行 SDK；验证 `ELECTRON_RUN_AS_NODE=1` 的开发与打包路径。
4. Windows unpacked/package 构建能找到同版本 dsh、启动子进程、写入独立 Harness home，并在退出时回收进程。
5. 验证 Persona、Skill、Tool 能否通过 profile、preset 或 patch 表达。
6. 如果标准 SDK 不能让不同 Session 选择不同 preset，则运行池按完整 Agent 配置哈希分组，不接入 Harness 私有 Web Remote API。

## 核心接口

```ts
type RuntimeKey = {
  provider: string
  model: string
  capabilityProfileHash: string
}

interface HarnessRuntimePool {
  acquire(key: RuntimeKey): Promise<HarnessRuntime>
  shutdownIdle(): Promise<void>
  shutdownAll(): Promise<void>
}

interface HarnessRuntime {
  run(input: {
    harnessSessionId: string
    prompt: string
    onEvent(event: HarnessEvent): void
  }): Promise<RunResult>
  health(): RuntimeHealth
}

interface SessionRuntimeSnapshot {
  provider: string
  model: string
  capabilityProfileHash: string
  harnessSessionId: string
}
```

## 数据与上下文原则

- Agent 的模型、Persona、Skill、Tool 修改只影响新 Session；已有 Session 保留创建时快照。
- Product SQLite 是 Agent、Space、成员关系和共享聊天记录的权威来源。
- Harness Session log 是单个 Agent 运行历史的权威来源。
- 私聊只发送当前新消息，不重复发送最近历史。
- 每个 `Agent × Space` 保存独立 Session 和 `lastConsumedMessageSequence`。
- Agent 被 `@` 时只注入尚未看到的共享消息、当前 Space Context 和本次用户消息。
- Harness 原始事件在 Adapter 中归一化，renderer 不接触 Harness 私有类型。

## 测试与 Go/No-Go

- 相同 runtime key 复用，不同 key 隔离；崩溃可检测和恢复。
- 两个 Agent 私聊不串历史；同一 Agent 在两个 Space 中不串上下文。
- 不同 Agent 能使用不同 provider/model，实际请求头与配置一致。
- 多 Agent mention 按选择顺序运行，后一个 Agent 能看到前一个回复。
- Persona 不互相污染，共享消息不重复注入。
- API Key 不出现在数据库、日志、IPC 或 Git diff。
- Windows 安装包能启动 Harness、流式返回并正常退出。
- PoC、双模型隔离、Electron 打包运行三项全部通过后，才进入正式产品开发。

## 默认假设

- MVP 为 Windows x64、本地单用户桌面应用。
- 首个真实 Provider 使用 DeepSeek，第二个 Provider 仅用于验证运行池。
- “统一 Runtime”指统一 Harness 技术与 Adapter，不强制只有一个系统进程。
- TeamAI 与 agent-workflow-platform 只作第二阶段参考，不在 MVP 集成。
