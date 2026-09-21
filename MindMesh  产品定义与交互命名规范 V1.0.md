# MindMesh Multi-Agent Platform 产品定义与交互命名规范 V1.0

版本：V1.0  
阶段：MVP  
文档类型：产品定义 / 交互命名 / UI 信息架构

---

# 1. 产品定位

本产品是一款通用 Multi-Agent 平台。

平台允许用户：

- 创建多个 Agent
- 自定义每个 Agent 的身份、角色和行为方式
- 为不同 Agent 选择不同模型
- 为 Agent 配置 Skill 和 Tool
- 单独与某个 Agent 对话
- 创建多个协作空间
- 将不同 Agent 加入同一个协作空间
- 在共享空间中通过 @Agent 的方式指定 Agent 参与讨论或执行任务
- 让同一个 Agent 同时参与多个不同协作空间

Agent 不预设为“员工”“助手”“专家”等固定身份。

Agent 的身份由用户自行定义。

典型示例：

- 数据分析师
- 软件工程师
- 产品经理
- 市场专家
- 研究助手
- 老师
- 小说角色
- 游戏 NPC
- 法律顾问
- 虚拟角色
- 用户自定义的任意身份

因此，产品定位不是：

> AI 数字员工平台

而是：

> 通用多智能体创建、交互与协作平台。

数字员工只是其中一种使用场景。

---

# 2. 产品一句话定义

推荐定义：

> 创建不同身份和能力的智能体，并让它们在不同协作空间中共同完成任务。

英文：

> Create agents, give them abilities, and let them collaborate in shared spaces.

---

# 3. 产品名称建议

## 3.1 主推荐名称

# MindMesh

含义：

- Mind：独立智能体 / 思维实体
- Mesh：多个智能体形成连接和协作网络

适合表达：

- 多 Agent
- 多身份
- 多模型
- 多空间
- 协同工作

推荐副标题：

> Multi-Agent Collaboration Platform

中文副标题：

> 多智能体创建与协作平台

推荐 Slogan：

> Create minds. Build teams. Work together.

或：

> 创建智能体，让不同智能协同工作。

---

## 3.2 备选名称

### AgentSpace

特点：

- 直观
- 容易理解
- 强调 Agent + Space

缺点：

- 品牌辨识度相对一般

---

### AgentMesh

特点：

- 技术属性更强
- 明确体现多 Agent 网络

适合：

- 开发者 / 技术用户

---

### PolyMind

特点：

- Poly 表示多个
- 品牌感较强
- 不局限于工作场景

---

### MindSpace

特点：

- 直观表达智能体共享空间
- 偏通用型

---

### Converge AI

特点：

- 强调多个 Agent 汇聚、协作
- 偏商务风

---

# 4. 产品核心对象

MVP 对用户暴露以下核心概念：

```text
Agent
Chat
Space
Skill
Tool
Model
```

不要在用户界面直接暴露：

```text
Runtime
Harness
Session
ContextBuilder
Provider Adapter
Agent Loop
```

这些属于技术实现层。

---

# 5. 产品术语规范

| 技术术语 | 产品展示名称 | 英文 UI |
|---|---|---|
| Agent | 智能体 | Agent |
| Create Agent | 创建智能体 | Create Agent |
| Persona | 身份设定 | Identity |
| Role | 角色定位 | Role |
| System Prompt | 行为指令 | Instructions |
| Model Provider | 模型服务商 | Provider |
| Model | 模型 | Model |
| Skill | 技能 | Skill |
| Tool | 工具 | Tool |
| Private Chat | 对话 / 单聊 | Chat |
| Workplace | 协作空间 | Space |
| Workplace Member | 空间成员 | Members |
| Workplace Context | 背景信息 | Space Context |
| Session | 不展示 | - |
| Runtime | 不展示 | - |
| DeepSeek Harness | 不展示 | - |
| ContextBuilder | 不展示 | - |

---

# 6. 产品核心信息架构

左侧导航建议：

```text
MindMesh

对话
────────────
Researcher
Writer
Developer

协作空间
────────────
AI Product Research
Novel Project
Marketing Plan

────────────
智能体
技能
工具
设置
```

对应英文：

```text
Chats

Spaces

Agents
Skills
Tools
Settings
```

---

# 7. Agent 的产品定义

Agent 定义：

> 一个由用户创建并赋予身份、模型、技能和工具的独立智能实体。

Agent 的核心组成：

```text
Agent
├── 名称
├── 头像
├── 角色定位
├── 身份设定
├── 模型
├── 技能
└── 工具
```

Agent 不绑定某一个 Space。

同一个 Agent 可以：

```text
单独对话
加入 Space A
加入 Space B
加入 Space C
```

在所有 Space 中：

```text
Identity 不变
Skills 不变
Tools 不变
```

但：

```text
Space Background 不同
Conversation 不同
```

---

# 8. 创建 Agent 的产品流程

入口按钮：

> + 创建智能体

页面标题：

> 创建你的智能体

副标题：

> 定义它是谁、会什么，以及可以使用哪些工具。

---

## 8.1 Step 1：定义身份

页面标题：

> 它是谁？

字段：

### 名称

示例：

```text
Researcher
Alice
Data Analyst
Athena
```

### 头像

支持：

- 默认头像
- Emoji
- 用户上传头像

MVP 可只支持默认头像。

### 角色定位

示例：

```text
研究分析专家
软件工程师
产品经理
小说编辑
```

### 身份描述

产品名称：

> 身份设定

底层：

```text
Persona
```

示例：

```text
你是一名严谨的研究分析专家。

你擅长整理复杂资料、查找证据并形成结构化结论。

在回答问题时优先使用事实和证据，不随意推测。
```

---

# 9. Step 2：选择模型

页面标题：

> 选择模型

字段：

### 模型服务商

例如：

```text
OpenAI
Anthropic
DeepSeek
Google
Other
```

### 模型

根据 Provider 动态显示。

例如：

```text
GPT
Claude
DeepSeek
Gemini
```

产品提示：

> 不同模型在推理、编程、创作和速度方面各有特点。

不向用户展示：

```text
API Protocol
LLM Adapter
Runtime Provider
```

---

# 10. Step 3：添加技能

页面标题：

> 它会什么？

对应底层：

```text
Skills
```

示例：

```text
研究分析
数据分析
代码审查
市场研究
文案创作
报告撰写
创意写作
```

按钮：

> + 添加技能

如果暂无 Skill：

```text
还没有安装技能
```

引导：

> 前往技能库添加更多能力。

---

# 11. Step 4：添加工具

页面标题：

> 它可以使用哪些工具？

对应底层：

```text
Tools
```

示例：

```text
网页搜索
文件
Python
Excel
Shell
数据库
浏览器
```

按钮：

> + 添加工具

最终按钮：

> 创建智能体

---

# 12. Agent 详情页

建议结构：

```text
Researcher

研究分析专家

────────────────

身份设定

擅长市场调研、信息检索和结构化分析。

────────────────

模型

GPT

────────────────

技能

研究分析
报告撰写

────────────────

工具

网页搜索
文件

────────────────

[ 开始对话 ]

[ 编辑智能体 ]

[ 加入协作空间 ]
```

---

# 13. Agent Card

推荐建立统一 Agent Card。

用于：

- Agent 列表
- Space 成员列表
- Agent 选择器
- Mention 自动补全

Agent Card 内容：

```text
Researcher

研究分析专家

GPT

研究分析 · 报告撰写
```

未来可扩展：

```text
复制 Agent
导入 Agent
导出 Agent
分享 Agent
```

---

# 14. Private Chat

产品名称：

> 对话

不要强调：

```text
Private Session
Private Context
```

界面表现为：

```text
User
 ↕
Agent
```

例如：

```text
Researcher
────────────────

User:
帮我分析一下这个行业。

Researcher:
……
```

单聊内容默认不进入任何 Space。

---

# 15. Space 的产品定义

技术层名称：

```text
Workplace
```

产品层名称：

> 协作空间

英文：

> Space

定义：

> 一个可以将多个 Agent 聚集到一起、共享背景和对话内容的协作环境。

Space 可以代表：

- 一个项目
- 一个研究问题
- 一次讨论
- 一个创作团队
- 一个虚拟世界
- 一个模拟会议
- 一个复杂任务

---

# 16. 为什么使用 Space 而不是 Workplace

Workplace 容易产生：

```text
办公
企业
员工
公司
```

等强业务联想。

Space 更通用。

例如：

```text
AI 产品研究
```

是一个 Space。

```text
小说世界观
```

也是一个 Space。

```text
投资研究
```

也是一个 Space。

---

# 17. 创建 Space

入口：

> + 新建空间

页面标题：

> 创建协作空间

---

## 17.1 Space Name

字段：

> 空间名称

示例：

```text
AI Product Research
Novel Project
Marketing Plan
```

---

## 17.2 Description

字段：

> 简介

用于简单描述这个 Space 是做什么的。

例如：

```text
讨论和研究 Multi-Agent 产品设计。
```

---

## 17.3 Space Context

产品名称：

> 背景信息

不要直接叫：

```text
Context
```

用户可以填写：

```text
当前目标
项目背景
已有结论
主要限制
关键规则
```

示例：

```text
当前目标：

开发一款基于 DeepSeek Harness 的多 Agent 平台。

当前阶段：

MVP。

核心需求：

用户可以创建 Agent，并把多个 Agent 放到同一个 Space 中协作。
```

---

# 18. 添加 Agent 到 Space

产品名称：

> 添加智能体

展示：

```text
☑ Researcher
☑ Product Manager
☑ Developer
□ Writer
```

创建完成后：

```text
Space
├── Researcher
├── Product Manager
└── Developer
```

---

# 19. Space 页面结构

推荐布局：

```text
┌────────────────────────────────────┐
│ AI Product Research                │
│ 3 个智能体                          │
├────────────────────────────────────┤
│                                    │
│ Conversation                       │
│                                    │
│ User                               │
│ @Researcher 查一下类似产品          │
│                                    │
│ Researcher                         │
│ ……                                 │
│                                    │
├────────────────────────────────────┤
│ @智能体 输入消息……             Send │
└────────────────────────────────────┘
```

右侧面板：

```text
成员

Researcher
Product Manager
Developer

────────────

背景信息

[编辑]
```

---

# 20. Space 成员面板

产品名称：

> 成员

内容：

```text
Researcher
研究分析
GPT

Product Manager
产品策略
Claude

Developer
软件开发
DeepSeek
```

按钮：

> + 添加智能体

不要叫：

```text
Agent Membership
```

---

# 21. @Agent 交互

这是 MVP 核心交互之一。

用户在 Space 中输入：

```text
@Researcher
帮我找一下目前类似的开源项目。
```

只触发 Researcher。

然后：

```text
@ProductManager
根据 Researcher 刚才的结果分析一下。
```

Product Manager 可以看到 Space 中刚刚产生的内容。

---

# 22. @Mention 自动补全

用户输入：

```text
@
```

出现：

```text
Researcher
Product Manager
Developer
```

点击即可插入：

```text
@Researcher
```

避免：

- Agent 名称拼写错误
- 找不到 Agent
- @歧义

---

# 23. 多 Agent Mention

允许：

```text
@Researcher @ProductManager
你们分别怎么看？
```

MVP 的产品表现：

```text
Researcher 回答
↓
Product Manager 回答
```

不向用户解释：

```text
Sequential Agent Execution
```

只是表现为多个 Agent 依次参与讨论。

---

# 24. Agent 的多 Space 使用

例如：

```text
Researcher
```

可以加入：

```text
AI Research
Market Research
Robotics Research
```

产品上表现：

Agent 详情页增加：

> 所在空间

例如：

```text
AI Research
Market Research
Robotics Research
```

Agent Identity 不改变。

---

# 25. Space Background 与 Agent Identity

产品设计必须遵循：

```text
Agent Identity
=
这个 Agent 是谁

Space Background
=
它当前在哪里、正在讨论什么
```

例如：

```text
Researcher

Identity:
研究分析专家
```

进入：

```text
AI Research Space
```

后：

```text
Researcher Identity
+
AI Research Background
```

进入：

```text
Robotics Space
```

则：

```text
Researcher Identity
+
Robotics Background
```

---

# 26. Chat 与 Space 的差异

## Chat

```text
User
+
Single Agent
```

特点：

- 一对一
- 不属于某个 Space
- 不共享给其他 Agent

---

## Space

```text
User
+
Multiple Agents
```

特点：

- 多 Agent
- 共享 Space Background
- 共享 Conversation
- 支持 @Agent

---

# 27. Skills 页面

页面名称：

> 技能

英文：

> Skills

推荐二级标题：

> 技能库

展示：

```text
研究分析

帮助 Agent 进行资料整理和研究分析。

[已安装]
```

以及：

```text
代码审查

帮助 Agent 检查代码质量。

[添加]
```

MVP 如果不做在线市场：

只展示：

```text
已安装技能
```

---

# 28. Tools 页面

页面名称：

> 工具

英文：

> Tools

例如：

```text
网页搜索

文件

Python

Shell

Excel
```

显示状态：

```text
可用
不可用
需要配置
```

---

# 29. Settings 页面

MVP Settings 建议分：

```text
模型服务

Runtime

数据
```

---

## 29.1 模型服务

例如：

```text
OpenAI
已连接

Anthropic
未连接

DeepSeek
已连接
```

按钮：

```text
连接
编辑
移除
```

---

## 29.2 Runtime

产品层不要显示：

```text
DeepSeek Harness
```

除非用户是开发者模式。

普通用户只显示：

```text
运行状态

● 正常运行
```

高级设置中可以显示：

```text
Runtime Version
Logs
Restart Runtime
```

---

# 30. 用户不应该看到的技术术语

普通 UI 禁止出现：

```text
Harness
Agent Loop
Session ID
ContextBuilder
SQLite
Provider Adapter
Tool Registry
Skill Registry
IPC
Runtime Child Process
```

它们只应该出现在：

```text
开发者模式
日志
错误详情
```

---

# 31. MVP 页面树

```text
App

├── Chats
│   └── Agent Chat
│
├── Spaces
│   └── Space Chat
│
├── Agents
│   ├── Agent List
│   ├── Agent Detail
│   └── Agent Editor
│
├── Skills
│
├── Tools
│
└── Settings
```

---

# 32. 首页建议

MVP 可以直接默认进入：

> Chats

如果暂无 Agent：

显示：

```text
还没有智能体

创建第一个智能体，开始你的 Multi-Agent 工作空间。

[创建智能体]
```

---

# 33. 空状态

## No Agents

```text
还没有智能体

创建一个属于你的智能体。

[创建智能体]
```

## No Spaces

```text
还没有协作空间

把多个智能体放进同一个空间，让它们一起讨论和完成任务。

[新建空间]
```

## No Skills

```text
暂无可用技能
```

## No Tools

```text
暂无可用工具
```

---

# 34. 产品核心路径

MVP 最核心 User Flow：

```text
打开应用
↓
创建 Agent A
↓
定义身份
↓
选择模型
↓
添加 Skill / Tool
↓
创建 Agent
↓
和 Agent 单聊
↓
创建 Agent B
↓
创建 Space
↓
添加 A + B
↓
填写背景信息
↓
@Agent A
↓
Agent A 回复
↓
@Agent B
↓
Agent B 基于共享 Space 内容继续回复
```

这条链路必须成为 MVP 第一优先级。

---

# 35. 产品价值表达

产品不强调：

> 我们支持很多 Agent。

而应该强调：

> 你可以创建不同身份、不同能力、不同模型的智能体，并根据任务自由组合。

核心价值：

```text
自由创建
自由组合
身份独立
共享协作
统一底座
```

---

# 36. 产品核心概念总结

最终产品对用户只需要解释六个概念：

## Agent

> 一个由你定义身份和能力的智能体。

## Model

> Agent 使用的大模型。

## Skill

> Agent 掌握的工作方法和能力。

## Tool

> Agent 可以调用的实际工具。

## Chat

> 你和某个 Agent 的单独对话。

## Space

> 多个 Agent 共享背景并一起协作的空间。

---

# 37. 推荐最终产品语言

品牌：

# MindMesh

产品定位：

> 多智能体创建与协作平台

主导航：

```text
对话
协作空间
智能体
技能
工具
设置
```

核心按钮：

```text
创建智能体
开始对话
新建空间
添加智能体
添加技能
添加工具
编辑背景
```

核心交互：

```text
@Agent
```

核心关系：

```text
Create Agent
↓
Configure Identity
↓
Choose Model
↓
Add Skills
↓
Add Tools
↓
Chat
↓
Create Space
↓
Add Agents
↓
Collaborate
```

---

# 38. 一句话总结

> MindMesh 是一个通用 Multi-Agent 平台，用户可以自由创建不同身份、不同模型和不同能力的 Agent，并通过私聊或共享协作空间，让多个 Agent 以各自独立身份共同完成任务。
