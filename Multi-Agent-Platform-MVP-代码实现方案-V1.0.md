# Multi-Agent Platform MVP 代码实现方案 V1.0

## 1. 技术栈

建议：

```text
Electron
React
TypeScript
Vite

SQLite
Drizzle ORM

DeepSeek Harness
```

打包：

```text
electron-builder
```

---

## 2. Monorepo 目录

推荐：

```text
multi-agent-platform/
│
├── package.json
├── pnpm-workspace.yaml
│
├── apps/
│   └── desktop/
│       ├── src/
│       │   ├── main/
│       │   ├── preload/
│       │   └── renderer/
│       └── package.json
│
├── packages/
│   ├── domain/
│   ├── application/
│   ├── database/
│   ├── context/
│   └── harness-adapter/
│
├── skills/
│
└── data/
```

---

## 3. Domain 层

路径：

```text
packages/domain
```

包含：

```text
Agent.ts
Workplace.ts
Session.ts
Message.ts
```

---

## 4. Agent 类型

```ts
export interface Agent {
  id: string

  name: string
  avatar?: string

  role?: string
  persona: string

  modelProvider: string
  modelId: string

  createdAt: string
  updatedAt: string
}
```

Skill / Tool 使用关联表。

---

## 5. Workplace

```ts
export interface Workplace {
  id: string

  name: string
  description?: string

  context: string

  createdAt: string
  updatedAt: string
}
```

---

## 6. Session

```ts
export type SessionType =
  | "private"
  | "workplace"

export interface Session {
  id: string

  agentId: string

  type: SessionType

  workplaceId?: string

  harnessSessionId?: string

  modelProvider: string
  modelId: string

  createdAt: string
  updatedAt: string
}
```

注意：

Agent 修改默认模型以后：

```text
已有 Session
```

不自动修改。

新 Session 使用：

```text
Agent 当前 Model
```

---

## 7. Message

```ts
export interface Message {
  id: string

  conversationType:
    | "private"
    | "workplace"

  agentId?: string
  workplaceId?: string

  senderType:
    | "user"
    | "agent"
    | "system"

  senderId: string

  content: string

  createdAt: string
}
```

---

## 8. SQLite Schema

### agents

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,

  name TEXT NOT NULL,
  avatar TEXT,

  role TEXT,

  persona TEXT NOT NULL,

  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### workplaces

```sql
CREATE TABLE workplaces (
  id TEXT PRIMARY KEY,

  name TEXT NOT NULL,

  description TEXT,

  context TEXT NOT NULL DEFAULT '',

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### workplace_members

```sql
CREATE TABLE workplace_members (
  workplace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,

  joined_at TEXT NOT NULL,

  PRIMARY KEY (
    workplace_id,
    agent_id
  )
);
```

### sessions

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,

  agent_id TEXT NOT NULL,

  type TEXT NOT NULL,

  workplace_id TEXT,

  harness_session_id TEXT,

  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Private Session 唯一：

```text
agent_id + type(private)
```

Workplace Session 唯一：

```text
agent_id
+
workplace_id
+
type(workplace)
```

### messages

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,

  conversation_type TEXT NOT NULL,

  agent_id TEXT,
  workplace_id TEXT,

  sender_type TEXT NOT NULL,
  sender_id TEXT NOT NULL,

  content TEXT NOT NULL,

  created_at TEXT NOT NULL
);
```

### agent_skills

```sql
CREATE TABLE agent_skills (
  agent_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,

  PRIMARY KEY (
    agent_id,
    skill_id
  )
);
```

### agent_tools

```sql
CREATE TABLE agent_tools (
  agent_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,

  PRIMARY KEY (
    agent_id,
    tool_id
  )
);
```

---

## 9. Application Service

路径：

```text
packages/application
```

核心：

```text
AgentService
WorkplaceService
SessionService
ChatService
```

不要第一版创建：

```text
WorkflowService
MemoryService
TaskService
RouterService
```

---

## 10. AgentService

```ts
export class AgentService {

  createAgent(
    input: CreateAgentInput
  ): Promise<Agent>

  updateAgent(
    id: string,
    input: UpdateAgentInput
  ): Promise<Agent>

  deleteAgent(
    id: string
  ): Promise<void>

  getAgent(
    id: string
  ): Promise<Agent | null>

  listAgents():
    Promise<Agent[]>
}
```

---

## 11. WorkplaceService

```ts
export class WorkplaceService {

  create(
    input: CreateWorkplaceInput
  ): Promise<Workplace>

  update(
    id: string,
    input: UpdateWorkplaceInput
  ): Promise<Workplace>

  addAgent(
    workplaceId: string,
    agentId: string
  ): Promise<void>

  removeAgent(
    workplaceId: string,
    agentId: string
  ): Promise<void>

  listMembers(
    workplaceId: string
  ): Promise<Agent[]>
}
```

---

## 12. SessionService

```ts
export class SessionService {

  getOrCreatePrivate(
    agentId: string
  ): Promise<Session>

  getOrCreateWorkplace(
    agentId: string,
    workplaceId: string
  ): Promise<Session>
}
```

---

## 13. Session 创建逻辑

```ts
async getOrCreateWorkplace(
  agentId: string,
  workplaceId: string
) {

  const existing =
    await sessionRepo.findWorkplaceSession(
      agentId,
      workplaceId
    )

  if (existing) {
    return existing
  }

  const agent =
    await agentRepo.findById(agentId)

  const runtimeSession =
    await harnessAdapter.createSession({
      modelProvider:
        agent.modelProvider,

      modelId:
        agent.modelId
    })

  const session: Session = {
    id: crypto.randomUUID(),

    agentId,

    workplaceId,

    type: "workplace",

    harnessSessionId:
      runtimeSession.id,

    modelProvider:
      agent.modelProvider,

    modelId:
      agent.modelId,

    createdAt: now(),
    updatedAt: now()
  }

  await sessionRepo.insert(session)

  return session
}
```

---

## 14. Harness Adapter

路径：

```text
packages/harness-adapter
```

定义：

```ts
export interface HarnessAdapter {

  initialize(): Promise<void>

  createSession(
    input: CreateSessionInput
  ): Promise<HarnessSession>

  sendMessage(
    input: HarnessMessageInput
  ): AsyncIterable<HarnessEvent>

  listSkills():
    Promise<HarnessSkill[]>

  listTools():
    Promise<HarnessTool[]>

  listModels():
    Promise<HarnessModel[]>
}
```

参考：
- DeepSeek Harness Remote API/BFF
  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/README.md

---

## 15. Harness Event

借鉴 agent-workflow-platform 的显式 streaming contract 思路，但不采用它的多 Runtime 架构。

```ts
export type HarnessEvent =

  | {
      type: "session.started"
      sessionId: string
    }

  | {
      type: "message.delta"
      text: string
    }

  | {
      type: "tool.started"
      toolName: string
    }

  | {
      type: "tool.completed"
      toolName: string
      result?: unknown
    }

  | {
      type: "message.completed"
    }

  | {
      type: "runtime.error"
      code: string
      message: string
    }
```

参考：
- https://github.com/primorLee/agent-workflow-platform

---

## 16. DeepSeekHarnessAdapter

```ts
export class DeepSeekHarnessAdapter
  implements HarnessAdapter {

  async initialize() {
    // boot Harness Host
  }

  async createSession(input) {
    // call Harness session API
  }

  async *sendMessage(input) {
    // convert Harness stream
    // to internal HarnessEvent
  }

  async listSkills() {
    // read Harness Skill Registry
  }

  async listTools() {
    // read Tool Registry
  }

  async listModels() {
    // read Provider/Model catalog
  }
}
```

---

## 17. Skill 来源

不在 Product DB 存 Skill 正文。

DB 只保存：

```text
skill_id
```

实际 Skill：

```text
Harness Skill Registry
```

参考：
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/README.md

---

## 18. Tool 来源

同理。

DB：

```text
tool_id
```

Runtime：

```text
Harness Tool Registry
```

---

## 19. Model 列表

Agent Builder 打开时：

```text
HarnessAdapter.listModels()
```

返回：

```ts
interface HarnessModel {
  providerId: string
  modelId: string
  displayName: string
}
```

展示：

```text
Provider:
OpenAI

Model:
GPT-xxx
```

参考：
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md

---

## 20. ContextBuilder

路径：

```text
packages/context
```

MVP 只写：

```ts
export class ContextBuilder {

  buildPrivate(...)

  buildWorkplace(...)
}
```

### Private Context

```ts
async buildPrivate({
  agent,
  messages
}) {

  return {
    systemPrompt: `
You are ${agent.name}.

ROLE:
${agent.role ?? ""}

PERSONA:
${agent.persona}
    `.trim(),

    messages
  }
}
```

### Workplace Context

```ts
async buildWorkplace({
  agent,
  workplace,
  messages
}) {

  return {
    systemPrompt: `
You are ${agent.name}.

ROLE:
${agent.role ?? ""}

PERSONA:
${agent.persona}

You are participating
in a shared workplace.

WORKPLACE:
${workplace.name}

WORKPLACE CONTEXT:
${workplace.context}

Always maintain your own
identity and role.
    `.trim(),

    messages
  }
}
```

---

## 21. Context 数量

MVP：

```ts
const MESSAGE_LIMIT = 30
```

查询最近：

```text
30 条
```

不做：

```text
Vector Search
Summarization
Recall
```

---

## 22. Future Context Interface

预留：

```ts
export interface ContextProvider {

  getContext(
    input: ContextQuery
  ): Promise<ContextItem[]>

}
```

MVP 实现：

```text
StaticWorkplaceContextProvider
RecentMessageContextProvider
```

以后可以加入：

```text
TeamAIRecallProvider
MemoryProvider
RAGProvider
```

TeamAI 作为第二阶段 Context 参考。

参考：
- https://github.com/Tencent/teamai-cli
- https://github.com/Tencent/teamai-cli/blob/main/docs/usage-guide.md

---

## 23. MentionParser

```ts
export function parseMentions(
  content: string,
  members: Agent[]
): Agent[] {

  return members.filter(agent =>
    content.includes(
      `@${agent.name}`
    )
  )
}
```

MVP 足够。

UI 应提供：

```text
@ autocomplete
```

避免用户手打错误。

---

## 24. Workplace Chat

```ts
async sendWorkplaceMessage(
  workplaceId: string,
  content: string
) {

  await messageRepo.insertUserMessage({
    workplaceId,
    content
  })

  const workplace =
    await workplaceRepo.findById(
      workplaceId
    )

  const members =
    await workplaceRepo.getMembers(
      workplaceId
    )

  const mentioned =
    parseMentions(
      content,
      members
    )

  for (const agent of mentioned) {

    await runWorkplaceAgent(
      agent,
      workplace
    )
  }
}
```

---

## 25. runWorkplaceAgent

```ts
async function runWorkplaceAgent(
  agent: Agent,
  workplace: Workplace
) {

  const session =
    await sessionService
      .getOrCreateWorkplace(
        agent.id,
        workplace.id
      )

  const messages =
    await messageRepo
      .getRecentWorkplaceMessages(
        workplace.id,
        30
      )

  const context =
    contextBuilder.buildWorkplace({
      agent,
      workplace,
      messages
    })

  const skills =
    await skillRepo
      .getAgentSkills(agent.id)

  const tools =
    await toolRepo
      .getAgentTools(agent.id)

  const stream =
    harnessAdapter.sendMessage({
      sessionId:
        session.harnessSessionId!,

      systemPrompt:
        context.systemPrompt,

      messages:
        context.messages,

      skills,

      tools,

      model: {
        provider:
          session.modelProvider,

        id:
          session.modelId
      }
    })

  let finalText = ""

  for await (
    const event of stream
  ) {

    if (
      event.type ===
      "message.delta"
    ) {
      finalText += event.text

      emitToRenderer(
        "chat:delta",
        {
          workplaceId:
            workplace.id,

          agentId:
            agent.id,

          text:
            event.text
        }
      )
    }
  }

  await messageRepo
    .insertAgentMessage({
      workplaceId:
        workplace.id,

      agentId:
        agent.id,

      content:
        finalText
    })
}
```

---

## 26. 为什么顺序执行 Mention

使用：

```ts
for (
  const agent of mentioned
)
```

而不是：

```ts
Promise.all()
```

因为第二个 Agent 需要看到：

```text
第一个 Agent 的回答
```

所以每次执行前重新：

```text
getRecentWorkplaceMessages()
```

---

## 27. Private Chat

```ts
async sendPrivateMessage(
  agentId: string,
  content: string
) {

  const agent =
    await agentRepo.findById(agentId)

  const session =
    await sessionService
      .getOrCreatePrivate(agentId)

  await messageRepo
    .insertUserPrivateMessage({
      agentId,
      content
    })

  const messages =
    await messageRepo
      .getRecentPrivateMessages(
        agentId,
        30
      )

  const context =
    contextBuilder.buildPrivate({
      agent,
      messages
    })

  // Harness execution...
}
```

---

## 28. Electron 架构

参考 DeepSeek Harness Desktop 的：

```text
Electron Shell
+
Runtime Child Process
```

我们的结构：

```text
Electron Main
│
├── Harness Child
├── SQLite
├── IPC
└── Application Services

Electron Renderer
│
└── React UI
```

参考：
- https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md

---

## 29. Electron Main

```ts
async function bootstrap() {

  await database.initialize()

  await harnessAdapter.initialize()

  registerIPC()

  createWindow()
}
```

---

## 30. Runtime 生命周期

启动：

```text
EXE
↓
Electron Main
↓
Harness Host start
↓
等待 Ready
↓
初始化 Product Services
↓
打开 UI
```

关闭：

```text
Window Close
↓
停止新 Agent 请求
↓
Harness graceful shutdown
↓
SQLite close
↓
Exit
```

---

## 31. Harness Child Process

MVP 推荐：

```text
Harness Child Process
```

而不是：

```text
import Harness internal packages
```

这样升级隔离更清晰。

---

## 32. Renderer 与 Main

禁止：

```text
Renderer
→ SQLite

Renderer
→ Harness

Renderer
→ Node filesystem
```

统一：

```text
Renderer
↓
Preload API
↓
IPC
↓
Main
```

---

## 33. Preload API

```ts
contextBridge.exposeInMainWorld(
  "multiAgent",
  {

    agents: {
      list,
      create,
      update,
      remove
    },

    workplaces: {
      list,
      create,
      update,
      addAgent,
      removeAgent
    },

    chat: {
      sendPrivate,
      sendWorkplace,
      getPrivateMessages,
      getWorkplaceMessages
    },

    skills: {
      list
    },

    tools: {
      list
    },

    models: {
      list
    }
  }
)
```

---

## 34. Streaming IPC

使用：

```text
chat:start
chat:delta
chat:tool-start
chat:tool-end
chat:done
chat:error
```

参考：
- agent-workflow-platform 的流式 Desktop pipeline 和 durable conversation 思路
  https://github.com/primorLee/agent-workflow-platform

---

## 35. Renderer 页面

```text
/pages

ChatPage.tsx
WorkplacePage.tsx
AgentListPage.tsx
AgentEditorPage.tsx
SkillsPage.tsx
ToolsPage.tsx
SettingsPage.tsx
```

---

## 36. 左侧导航

```text
Chats
──────────
Research Agent
Writer
Developer

Workplaces
──────────
AI Project
Novel Project

──────────
Agents
Skills
Tools
Settings
```

---

## 37. Agent Editor

字段：

```text
Name
Role
Persona
Provider
Model
Skills
Tools
```

---

## 38. Provider / Model

页面不自己维护固定列表。

调用：

```text
models.list()
```

获取 Harness Model Catalog。

用户选择后保存：

```text
agents.model_provider
agents.model_id
```

---

## 39. Workplace 页面

布局：

```text
Header
│
├── Workplace Name
├── Members
└── Edit Context

Messages

Composer
│
└── @Agent
```

---

## 40. Workplace Context Editor

第一版：

```text
Textarea
```

即可。

不用 Markdown Editor library。

保存：

```text
workplaces.context
```

---

## 41. Agent Selector

添加 Agent：

```text
Add Member
```

读取：

```text
Agents
```

多选写入：

```text
workplace_members
```

---

## 42. Settings

MVP Settings：

```text
Harness Runtime Status
Model Providers
API Keys
Data Directory
```

Provider 配置优先直接映射 Harness Settings / Credentials。

---

## 43. API Key

正式版本：

```text
不要明文写 agents 表。
```

应由 Harness credential/settings 管理。

---

## 44. Error 类型

```ts
export enum ErrorCode {

  AGENT_NOT_FOUND,

  WORKPLACE_NOT_FOUND,

  AGENT_NOT_MEMBER,

  SESSION_ERROR,

  HARNESS_NOT_READY,

  MODEL_NOT_AVAILABLE,

  TOOL_ERROR,

  SKILL_ERROR,

  DATABASE_ERROR
}
```

---

## 45. Log

第一版：

```text
electron-log
```

日志：

```text
startup
harness lifecycle
session creation
agent execution
tool invocation
error
```

---

## 46. Harness 状态

UI 顶部或 Settings：

```text
Runtime

● Running
```

异常：

```text
● Runtime unavailable
```

不能 Harness 挂掉就整个 UI 白屏。

---

## 47. 开发 PoC

### PoC-01

```text
Electron
↓
Harness
↓
Model
↓
Stream
```

验收：

```text
Desktop 能正常收到流式文本
```

### PoC-02

创建两个 Harness Session：

```text
Session A
Session B
```

分别聊天。

验证历史完全隔离。

### PoC-03

两个 Persona：

```text
Agent A
Agent B
```

共享相同：

```text
Workplace Context
```

验证：

```text
共享项目内容
但保持不同身份
```

---

## 48. Sprint 1

实现：

```text
Electron shell
Harness lifecycle
Model provider config
Basic streaming chat
```

验收：

固定 Agent 可以聊天。

---

## 49. Sprint 2

实现：

```text
SQLite
Agent CRUD
Agent Editor
Model selection
```

验收：

创建不同身份和模型 Agent。

---

## 50. Sprint 3

实现：

```text
Private Chat
Private Session
Message Persistence
```

验收：

多个 Agent 私聊历史相互隔离。

---

## 51. Sprint 4

实现：

```text
Workplace CRUD
Add Agent
Remove Agent
Static Context
```

---

## 52. Sprint 5

实现：

```text
Workplace Chat
@ Mention
Agent × Workplace Session
Sequential Agent Run
```

这是 MVP 核心。

---

## 53. Sprint 6

实现：

```text
Skill Registry UI
Tool Registry UI
Agent Skill Binding
Agent Tool Binding
```

---

## 54. Sprint 7

实现：

```text
Installer
Runtime packaging
Error handling
Logs
Settings
```

Windows 输出：

```text
MultiAgentPlatform-Setup.exe
```

---

## 55. 第一版关键测试

必须有：

```text
Agent identity isolation test
Workplace isolation test
Private/workplace isolation test
Agent multi-workplace test
Session persistence test
Model selection test
Skill assignment test
Tool assignment test
Mention ordering test
Harness restart test
```

---

## 56. Workplace Isolation Test

例如：

```text
Agent A
```

加入：

```text
Project 1
Project 2
```

Project 1：

```text
secret = AAA
```

Project 2：

```text
secret = BBB
```

分别提问：

```text
secret 是什么？
```

必须：

```text
P1 → AAA
P2 → BBB
```

不能串。

---

## 57. Identity Isolation Test

Workplace：

```text
Agent A:
你是数据分析师

Agent B:
你是营销专家
```

群聊：

```text
你们分别给建议。
```

必须：

```text
A 使用数据分析身份
B 使用营销身份
```

不能互相人格污染。

---

## 58. 模型切换 Test

```text
Agent A = Provider 1
Agent B = Provider 2
```

确保：

```text
同一个 Harness Runtime
```

可以路由到不同模型。

---

## 59. MVP 不允许提前建设的东西

第一版开发过程中如果出现下面模块，应暂缓：

```text
MemoryManager
VectorStore
KnowledgeGraph
TaskScheduler
Worker
Redis
MessageQueue
WorkflowEngine
AgentRouter
SupervisorAgent
LearningEngine
```

除非核心 MVP 已经完成。

---

## 60. 第二阶段参考 TeamAI

未来做 Context 增强时，再参考：

```text
TeamAI Recall
Project Scope
Learnings
Knowledge Promotion
```

参考：
- https://github.com/Tencent/teamai-cli
- https://github.com/Tencent/teamai-cli/blob/main/docs/usage-guide.md

---

## 61. 第二阶段参考 agent-workflow-platform

当 Agent 开始执行长任务时，再考虑：

```text
Task
Worker
Retry
Lease
Checkpoint
Resume
Artifact
```

MVP 不集成其 FastAPI、Redis、Worker、Guardian 等组件。

参考：
- https://github.com/primorLee/agent-workflow-platform

---

## 62. 最终第一版代码边界

MVP 只需真正完成：

```text
AgentService
WorkplaceService
ChatService
SessionService
ContextBuilder
MentionParser
HarnessAdapter
```

七个核心模块。

底层：

```text
DeepSeek Harness
```

负责所有 Agent Runtime 能力。

---

## 63. 参考项目标注

### [REF-01] DeepSeek Harness

用途：

```text
统一 Agent Runtime
Session
Agent Loop
System Prompt
Tool Registry
Skill Registry
LLM Provider
Model Selection
```

参考：
- https://github.com/deepseek-ai/deepseek-harness
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/README.md

### [REF-02] DeepSeek Harness Desktop

用途：

```text
Electron Runtime packaging
Harness Child Process
Desktop lifecycle
Windows packaging
```

参考：
- https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md

### [REF-03] Tencent TeamAI CLI

用途：

```text
第二阶段 Context
Project Scope
Recall
Learnings
Knowledge Improvement
```

MVP 暂不集成。

参考：
- https://github.com/Tencent/teamai-cli

### [REF-04] agent-workflow-platform

用途：

```text
Streaming Event Contract
Product State / Runtime State Separation
Desktop Conversation Persistence
Session Resume 思路
```

不参考：

```text
多 Runtime
FastAPI Control Plane
Redis Worker
Workflow Runtime
```

参考：
- https://github.com/primorLee/agent-workflow-platform

---

## 64. 最终实现原则

开发团队只需要记住：

```text
DeepSeek Harness
=
唯一 Runtime

Model
=
Agent 的可配置属性

Agent
=
Identity + Model + Skill + Tool

Workplace
=
Shared Context + Messages

Session
=
Agent 在一个具体 Context 下的运行状态

Private Chat
=
User ↔ Agent

Workplace Chat
=
User + Multiple Agents

@Agent
=
MVP 多 Agent 调度方式
```

第一版所有代码围绕这八条展开。
