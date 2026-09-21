# Multi-Agent Platform MVP 总体技术架构方案 V1.0

## 1. 文档目的

本文档用于定义第一版 Multi-Agent Platform 的完整技术架构。

第一版目标不是建设完整的企业级 Agent 基础设施，而是快速完成一个可以运行、演示和验证产品逻辑的 MVP。

平台核心定位：

> 基于统一 Agent Runtime 构建的通用多 Agent 创建、交互与协作平台。

Agent 不预设为“员工”“专家”或“助手”。

用户可以自行定义：

- Agent 名称
- Agent 身份
- Agent Persona
- Agent 使用模型
- Agent Skills
- Agent Tools

例如：

```text
Agent A
身份：数据分析专家
模型：GPT

Agent B
身份：小说编辑
模型：Claude

Agent C
身份：Python工程师
模型：DeepSeek

Agent D
身份：虚拟角色
模型：Gemini
```

这些 Agent：

```text
运行 Runtime 相同
Session 体系相同
Tool 体系相同
Skill 体系相同
Context 体系相同
```

只是在模型和能力配置上不同。

---

## 2. 核心架构原则

整个项目遵循六个核心原则。

### 2.1 一个统一 Agent Runtime

所有 Agent 都运行在：

```text
DeepSeek Harness
```

之上。

禁止第一版出现：

```text
Agent A → Harness

Agent B → Claude Code

Agent C → Codex
```

否则会导致：

```text
Session 不统一
Tool 不统一
Skill 不统一
Context 不统一
事件协议不统一
```

统一架构应为：

```text
              Multi-Agent Platform

                      │
                      ▼

               DeepSeek Harness

          ┌───────────┼───────────┐
          ▼           ▼           ▼
       Agent A     Agent B     Agent C
          │           │           │
         GPT      DeepSeek      Claude
```

DeepSeek Harness 本身已经将 Agent Loop、Session、System Prompt、Tool Registry 和默认模型选择拆为独立核心模块，适合作为统一 Runtime 主干。

参考：
- DeepSeek Harness Core
  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/README.md

---

## 3. 多模型架构

平台支持：

```text
一个 Runtime
+
多个 Model Provider
```

DeepSeek Harness 的 LLM 层采用 provider-neutral service，不同模型提供方通过 adapter 注册到统一 LLM service。

因此 Agent 创建时配置：

```text
Provider
+
Model
```

例如：

```text
Research Agent

Provider:
OpenAI

Model:
GPT-5.x
```

另外：

```text
Writer Agent

Provider:
Anthropic

Model:
Claude
```

Runtime 仍然：

```text
DeepSeek Harness
```

---

## 4. Model Provider Layer

平台中需要存在一个统一：

```text
Model Provider Layer
```

架构：

```text
Agent
 │
 │ modelProvider + modelId
 ▼
DeepSeek Harness
 │
 ▼
Harness LLM Layer
 │
 ├── DeepSeek
 ├── OpenAI-compatible
 ├── Anthropic-compatible
 └── Other Provider
```

Harness Provider 配置支持 Provider ID、Base URL、API Protocol、Credential 和 Model Catalog。

第一版产品不应自己重新实现 LLM HTTP Client。

优先复用 Harness 的：

```text
LLM Service
Provider Adapter
Credential
Model Selection
```

参考：
- DeepSeek Harness Providers
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md

---

## 5. Model 与 Session 的关系

Harness 当前模型选择与 Session 存在关系。

因此产品定义：

### 新 Agent

创建时配置：

```text
default model
```

例如：

```text
agent.model_provider = openai
agent.model_id = gpt-xxx
```

### 新 Session

使用 Agent 当前默认模型。

### 已存在 Session

MVP 建议保持原有模型。

如果用户修改 Agent Model：

```text
旧 Session → 保持旧模型

新 Session → 使用新模型
```

---

## 6. Agent 定义

Agent 是整个产品最核心的实体。

定义：

> 一个具有独立身份、模型、Skill 和 Tool 配置的可复用 AI 实体。

Agent 不属于任何 Workplace。

Agent 可以：

```text
独立存在
单独聊天
加入一个 Workplace
加入多个 Workplace
退出 Workplace
```

建议结构：

```text
Agent
├── Identity
├── Persona
├── Model
├── Skills
├── Tools
└── Runtime Config
```

---

## 7. Agent Identity

Identity 属于 Agent 自身。

例如：

```text
Name:
Alice

Role:
Marketing Strategist

Persona:
你是一名擅长海外市场策略的专家……
```

或者：

```text
Name:
Athena

Role:
Fantasy Character

Persona:
你是一名……
```

平台不对 Role 类型做约束。

DeepSeek Harness 的 Preset 体系支持 per-session Agent composition，Preset 可以组合 Prompt、Tool、Skill，同时 persona 可用于改变 Agent identity。

参考：
- DeepSeek Harness Preset
  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/README.md

---

## 8. Skill

Skill 表示：

> Agent 掌握的一套任务说明、方法论或工作能力。

例如：

```text
Research
Excel Analysis
Code Review
Social Marketing
Creative Writing
Report Writing
```

Skill 不等同于 Tool。

Skill 更接近：

```text
Instructions
Workflow Knowledge
Task Method
```

DeepSeek Harness 已有统一 Skill Registry。

因此：

```text
平台不重新设计 Skill Runtime。
```

平台只负责：

```text
安装
查看
选择
Agent-Skill 绑定
```

参考：
- DeepSeek Harness Skill
  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/README.md

---

## 9. Tool

Tool 表示：

> Agent 可以执行的实际能力。

例如：

```text
Web
Filesystem
Python
Shell
Excel
Database
MCP
```

平台负责：

```text
展示 Tool
选择 Tool
Agent-Tool 绑定
```

Harness 负责：

```text
Tool 注册
Tool Schema
Tool Execution
```

---

## 10. Private Chat

用户必须能够单独打开任何 Agent。

例如：

```text
User
 ↕
Research Agent
```

该聊天不属于任何 Workplace。

运行 Context：

```text
Agent Persona
+
Private Session History
+
Current Message
```

不加载其他 Workplace 信息。

因此：

```text
PrivateChat
```

必须和：

```text
WorkplaceChat
```

逻辑分离。

---

## 11. Workplace

Workplace 是多个 Agent 共同参与的共享上下文空间。

它可以是：

```text
一个项目
一个讨论组
一个研究课题
一个虚拟世界
一个创作团队
一个问题解决空间
```

不绑定“公司项目”概念。

结构：

```text
Workplace
├── Members
├── Shared Context
└── Messages
```

MVP 暂时不要做：

```text
自动 Memory
Task System
Artifact System
Knowledge Graph
```

---

## 12. Workplace 与 Harness Workspace 的区别

必须明确：

```text
我们的 Workplace
≠
DeepSeek Harness Workspace
```

### Product Workplace

由我们负责：

```text
成员
共享 Context
群聊
Agent Membership
```

### Harness Workspace

可以未来用于：

```text
工作目录
文件空间
Session grouping
```

但 MVP 不必强绑定。

参考：
- DeepSeek Harness Workspace
  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workspace/README.md

---

## 13. Workplace Shared Context

MVP 的共享 Context 不做复杂 Memory Engine。

直接保存一个：

```text
workplace.context
```

文本字段。

推荐 Markdown。

例如：

```markdown
# AI Agent Platform

当前目标：
开发一个多 Agent 桌面软件。

技术底座：
DeepSeek Harness

第一阶段：
完成 MVP。

核心逻辑：
Agent 可以自由创建，并加入多个 Workplace。
```

所有加入 Workplace 的 Agent 都可以读取。

---

## 14. Agent 身份不会因为进入 Workplace 改变

例如：

```text
Agent A
Persona:
数据分析师
```

和：

```text
Agent B
Persona:
产品经理
```

进入同一 Workplace：

```text
AI Project
```

共享：

```text
Workplace Context
```

但最终输入分别是：

```text
Agent A Context

Data Analyst Persona
+
AI Project Context
+
Group Messages
```

和：

```text
Agent B Context

Product Manager Persona
+
AI Project Context
+
Group Messages
```

所以：

> Workplace 共享环境，不共享身份。

---

## 15. Session 模型

### Private Session

```text
Agent
+
Private Chat
=
Private Session
```

### Workplace Session

```text
Agent
+
Workplace
=
Workplace Session
```

例如：

```text
Alice

Private
→ Session P1

Workplace A
→ Session W1

Workplace B
→ Session W2
```

这样能够实现：

```text
同一个 Agent
同一个 Identity
不同 Context
不同 Conversation State
```

---

## 16. Workplace Message 与 Agent Session

Workplace 群聊历史：

```text
Workplace Messages
```

属于 Workplace。

不是某个 Agent。

例如：

```text
User:
@A 分析一下。

A:
我的分析是……

User:
@B 看一下A的结论。

B:
……
```

这些全部写入：

```text
workplace_messages
```

Agent 被触发时，从 Workplace 读取最近消息构建 Context。

---

## 17. MVP Agent 协作方式

第一版采用：

```text
@Agent
```

触发。

例如：

```text
@DataAgent
分析一下这个问题。
```

系统：

```text
解析 Mention
↓
找到 Agent
↓
获取 Agent × Workplace Session
↓
构建 Context
↓
运行 Harness
↓
回复写入 Workplace
```

---

## 18. 多 Agent 同时 Mention

例如：

```text
@ResearchAgent @StrategyAgent
你们都说一下看法。
```

MVP 不做复杂编排。

使用：

```text
顺序执行
```

流程：

```text
Research Agent
↓
回复加入 Group Messages
↓
Strategy Agent
↓
重新读取 Group Messages
↓
看到 Research Agent 的回答
↓
回复
```

优点：

```text
简单
可预测
方便调试
Agent之间自然交流
```

---

## 19. Context 架构

MVP 不建设独立 Context Engine。

只保留：

```text
ContextBuilder
```

两种模式。

### Private Context

```text
Agent Persona
+
Recent Private Messages
```

### Workplace Context

```text
Agent Persona
+
Workplace Static Context
+
Recent Workplace Messages
```

---

## 20. TeamAI CLI 的参考边界

TeamAI 的 Context 体系包括：

```text
Recall
Docs
Learnings
Codebase Graph
TeamWiki
Improvement
```

这些思想值得后期借鉴。

MVP 暂时只参考：

```text
Context 应该按 Scope 隔离
```

不引入：

```text
Recall
Learning
Promotion
Knowledge Graph
```

参考：
- Tencent TeamAI CLI
  https://github.com/Tencent/teamai-cli
- Usage Guide
  https://github.com/Tencent/teamai-cli/blob/main/docs/usage-guide.md

---

## 21. Desktop 架构

技术栈：

```text
Electron
React
TypeScript
```

参考 DeepSeek Harness Desktop：

```text
Runtime 随 Desktop 一起分发
Harness 子进程生命周期
Desktop Runtime 独立 Profile
Windows 打包
```

参考：
- DeepSeek Harness Desktop
  https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md

---

## 22. 为什么不直接修改 Harness Desktop

不建议在官方 Desktop UI 上直接堆我们的功能。

推荐：

```text
自己的 Electron UI
+
自己的 Product Database
+
调用 Harness Host / API
```

Harness 继续作为底层 Runtime。

---

## 23. Product Layer

我们的 Application Layer 负责：

```text
Agent
Workplace
Membership
Conversation
Product Session Mapping
ContextBuilder
MentionParser
```

Harness 负责：

```text
Agent Loop
Runtime Session
System Prompt
Tool
Skill
LLM
Provider
Streaming
```

---

## 24. Harness API 接入

推荐：

```text
Application
↓
HarnessAdapter
↓
Harness Host/API
```

而不是侵入 Harness 内部 Package。

参考：
- DeepSeek Harness API
  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/README.md

---

## 25. HarnessAdapter

Adapter 目的：

```text
隔离 Harness API 变化
统一我们自己的调用接口
```

例如：

```text
createSession()

sendMessage()

listSkills()

listTools()

listModels()

setModel()
```

---

## 26. Streaming Event

参考：

`primorLee/agent-workflow-platform`

借鉴：

```text
统一事件协议
流式输出
Session ID 分离
Desktop/Product State 与 Runtime State 分离
```

不采用其多 Runtime、FastAPI Control Plane、Redis Worker 等重型架构。

建议内部事件：

```text
session.started

message.delta

tool.started

tool.completed

message.completed

runtime.error
```

参考：
- agent-workflow-platform
  https://github.com/primorLee/agent-workflow-platform

---

## 27. Product Session 与 Harness Session 分离

数据库保存：

```text
session.id
```

和：

```text
session.harness_session_id
```

例如：

```text
Product Session:
sess_001

Harness Session:
abc-def-xyz
```

---

## 28. MVP 数据架构

第一版使用：

```text
SQLite
```

数据对象：

```text
agents
workplaces
workplace_members
sessions
messages
agent_skills
agent_tools
```

Provider/Model 配置优先复用 Harness Settings。

---

## 29. 总体技术架构

```text
┌──────────────────────────────────────────┐
│            Multi-Agent Desktop           │
│                                          │
│  Agent Chat   Workplace   Agent Builder  │
│  Skills       Tools       Settings       │
└───────────────────┬──────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────┐
│             Application Layer            │
│                                          │
│ AgentService                             │
│ WorkplaceService                         │
│ ChatService                              │
│ SessionService                           │
│ MentionParser                            │
│ ContextBuilder                           │
└───────────────────┬──────────────────────┘
                    │
            ┌───────┴────────┐
            ▼                ▼
       Product SQLite   HarnessAdapter
                             │
                             ▼
┌──────────────────────────────────────────┐
│             DeepSeek Harness             │
│                                          │
│ Agent Loop                               │
│ Session                                  │
│ System Prompt                            │
│ Tools                                    │
│ Skills                                   │
│ LLM                                      │
└───────────────────┬──────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────┐
│             Model Providers              │
│                                          │
│ DeepSeek / OpenAI / Anthropic / Other    │
└──────────────────────────────────────────┘
```

---

## 30. MVP 产品页面

```text
1. Chats
2. Workplaces
3. Agents
4. Skills
5. Tools
6. Settings
```

---

## 31. 第一阶段明确不做

```text
Memory Engine
RAG
Vector DB
Graphiti
TeamAI Recall
Task Scheduler
Workflow Engine
自动 Agent Router
Agent Team Autonomous Collaboration
Task Queue
Worker
Redis
FastAPI Control Plane
多用户
Cloud Server
```

---

## 32. 开源参考关系

| 模块 | 来源 |
|---|---|
| Agent Loop | DeepSeek Harness |
| Session | DeepSeek Harness |
| Tool Registry | DeepSeek Harness |
| Skill Registry | DeepSeek Harness |
| Model Provider | DeepSeek Harness |
| Persona/Preset 思想 | DeepSeek Harness |
| Electron 打包思路 | DeepSeek Harness Desktop |
| Context Scope 思想 | TeamAI CLI |
| Future Recall/Learning | TeamAI CLI |
| Streaming Contract | agent-workflow-platform |
| Product/Runtime 状态解耦 | agent-workflow-platform |
| Agent Builder | 本项目 |
| Private Chat | 本项目 |
| Workplace | 本项目 |
| Agent × Workplace Session | 本项目 |
| @Agent 协作 | 本项目 |

---

## 33. 最终架构一句话

> 使用 DeepSeek Harness 作为统一 Agent Runtime，通过统一 Tool、Skill、Session 和模型 Provider 体系运行所有 Agent；用户可自由定义 Agent 身份和模型，并通过 Private Chat 或共享 Workplace Context 让多个 Agent 在统一底座内协作。
