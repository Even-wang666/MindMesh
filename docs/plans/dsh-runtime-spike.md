# DSH Runtime Spike 报告（Phase 0 / S0.1~S0.6）

> 日期：2026-10-05
> 实测环境：Windows / Node 24.14.0 / MindMesh `main@95b9572` / `@deepseek-ai/*0.2.0-rc.2`
> 模型：`deepseek-v4-flash`（deepseek-official）
> 脚本：`scripts/spike-events.mjs`（S0.1+S0.2）、`scripts/spike-interrupt.mjs`（S0.1 悬空验证）
> 原始数据：`logs/spike/s0-notifications.json`（68 KB，28 个 session.event 原文）
>
> **方法学说明**：本轮所有字段结论来自**实跑捕获的原始 payload**，不再靠 bundle 字符串猜测。
> 每条结论标注证据来源（`事件原文` / `代码位置` / `实测输出`）。

---

## 〇、结论速查

| 编号 | 问题 | 结论 | 对路线图的影响 |
|---|---|---|---|
| S0.1 | Tool Event payload | ✅ **已拿到完整字段** | Phase 1 可直接实现 |
| S0.1 | 配对关系 | ✅ 正常结束**严格配对**；⚠️ **中断会留悬空 tool/call** | Tool Card 必须有 `aborted` 态 |
| S0.1 | seq 是否原生 | ⚠️ **原生提供，但作用域是 Session** | 排序/去重必须带 Session 身份 |
| S0.2 | usage 字段 | ✅ **5 个字段全有**（含 cache） | 可建表 |
| S0.2 | 增量 or 累计 | ✅ **每条 assistant/message 是单次请求用量** | **必须累加**，不能取末条 |
| S0.3 | Tool Schema override | ❌ **未暴露** | `toolCatalog` 保持 Capability Catalog |
| S0.4 | Deferred tool loading | ❌ **不存在** | 本期不实现 |
| S0.5 | Context / Compaction | ⚠️ **部分**：`contextWindow` 可得；compaction 事件**存在但本轮未触发** | 计量环可用真实上限；压缩行为待实测 |
| S0.6 | FTS5 中文检索 | ⚠️ trigram 可用但 **<3 字符恒 0 命中** | Phase 6 必须做 LIKE 兜底 |

---

## S0.1 Tool Event

### 实测事件清单（14 类 + 4 类未文档化）

本次运行共捕获 **28 个 `session.event`** + 2 个 `session.status`。完整分布：

```text
turn/start × 1    turn/end × 1
step/start × 3    step/end × 3
tool/call × 2     tool/result × 2
assistant/message × 3
user/message × 4        system/message × 1
request/header × 1      request/context × 1
session/title × 1
agent/inbox/spliced × 2
session-log-deepseek/delivery-accepted × 3
```

**路线图未列出但实测存在**（可安全忽略，但不应写进 schema）：

| 事件 | 性质 | 处理 |
|---|---|---|
| `agent/inbox/spliced` | 内部队列事件 | 忽略 |
| `session/title` | 会话标题生成 | 忽略（可作Phase 2 Conversation 命名参考） |
| `session-log-deepseek/delivery-accepted` | Provider 投递回执 | 忽略 |
| `session.status`（非 `session.event`） | 传输层状态帧 | 忽略 |

### `tool/call` 完整 payload（证据：事件原文 seq=17）

```json
{
  "type": "tool/call",
  "seq": 17,
  "time": 1791175054980,
  "data": {
    "turn": 1,
    "step": 1,
    "callId": "call_00_ET_EugaXASh7fsO4ed2t3rv1684",
    "name": "pwsh",
    "arguments": "{\"command\": \"echo spike-marker\", \"description\": \"...\"}"
  }
}
```

字段说明：

| 字段 | 类型 | 说明 |
|---|---|---|
| `seq` | number | **Runtime 原生，但作用域是当前 Session**（详见下方 ⚠️） |
| `time` | number | epoch ms |
| `data.turn` | number | turn 序号，从 1 开始 |
| `data.step` | number | step 序号，从 1 开始 |
| `data.callId` | string | 工具调用唯一 ID，**配对依据** |
| `data.name` | string | 工具名（实测值：`pwsh`、`job_output`） |
| `data.arguments` | **string** | ⚠️ **是 JSON 字符串，不是对象** —— 必须 `JSON.parse` |

> ⚠️ **`arguments` 是字符串**（实测证据：值以 `{\"command\":` 开头）。
> MindMesh 若直接当对象用会拿到字符串。Tool Card 展示前需解析并容错。

### `tool/result` 完整 payload（证据：事件原文 seq=18）

```json
{
  "type": "tool/result",
  "seq": 18,
  "time": 1791175319090,
  "data": {
    "turn": 1,
    "step": 1,
    "message": {
      "role": "tool",
      "source": { "kind": "tool", "callId": "call_00_ET_..." },
      "toolCallId": "call_00_ET_...",
      "content": [{ "type": "text", "text": "[still running after 120000ms; ...]" }],
      "isError": false,
      "id": "f15db30a-b7c3-426e-b1d8-49dd556a0e40"
    }
  },
  "sourceEventSeqs": [17],
  "surfaceOp": "append"
}
```

| 字段 | 说明 |
|---|---|
| `data.message.toolCallId` | **配对依据**（实测与 `callId` 完全一致） |
| `data.message.isError` | 成功/失败判定 → Tool Card 状态 |
| `data.message.content[]` | `{type:'text', text}` 数组，需拼接 |
| `sourceEventSeqs` | 指向触发本次结果的 `tool/call` 的 seq |
| `surfaceOp` | 实测恒为 `"append"` |

**配对键有两个冗余可用**：`data.message.source.callId` 与 `data.message.toolCallId`（实测一致）。
建议用 `toolCallId`，语义更明确。

### 配对关系验证（实测）

正常结束的运行：

```text
tool/call#1   callId=call_00_ET_...  turn=1 step=1 seq=17
tool/result#1 toolCallId=call_00_ET_...  seq=18  sourceEventSeqs=[17]
tool/call#2   callId=call_00_qR3...  turn=1 step=2 seq=23
tool/result#2 toolCallId=call_00_qR3...  seq=24  sourceEventSeqs=[23]

callId 集合是否一致: true
```

→ **正常结束严格 1:1 配对**。

### ⚠️ 中断会留悬空 tool/call（关键发现）

用 `scripts/spike-interrupt.mjs` 在 `tool/call` 发出后关闭 runtime：

```text
事件序列: ... assistant/message > tool/call
tool/call ids   : ["call_00_diVP5zV9chovJBi3XTVW3605"]
tool/result ids : []
悬空(call 无 result): ["call_00_diVP5zV9chovJBi3XTVW3605"]
```

**结论：中断确实产生悬空 tool/call。**

对实现的直接影响：

| 场景 | 处理 |
|---|---|
| 收到 `tool/call`，runtime 被关闭 | Tool Card 落`status='aborted'` |
| 应用崩溃后启动修复 | 同上：`running` → `aborted` |

> 这验证了路线图 §4.5 中 `tool_calls.status` 必须包含 `aborted` —— 不是防御性设计，是**实测必需**。

### 关键：`seq` 是 Runtime 原生，但**作用域是当前 Session**

```text
带 seq 的事件 28 个 | 范围 3~30 | 单调递增 true
```

⚠️ **复审修正**：原文写「全局单调递增」，**不准确**。

代码证据（`dsh-session/lib/index.js`）：

```js
seq: SessionSeq(this.log.length, ...)   // 按当前 Session 的 log.length 生成
seq = this._lastProcessedSeq + 1        // 同 Session 内前一事件 +1
seq = last.seq + 1                      // 同 Session 内递增
// 连续性检查也只在 Session 内成立：
throw new Error(`session event seq ${event.seq} is not contiguous; expected ${expectedSeq}`)
```

| 结论 | 说明 |
|---|---|
| ✅ 单个 Session 内严格单调递增 | 连续性由 Runtime 强校验（`is not contiguous`） |
| ❌ **不是跨 Session 的全局序号** | 不同 Session 各自从较小值开始，**必然撞号** |

### ⚠️ 复审再修正：`runId` **不能**代表 Session 身份

原文写「`runId` 就是 Session 身份」——**错误**。

`dsh-sdk-client/lib/index.js` 证据：

```js
const subscription = client.subscribeSessionTree(this.id)
const collect = (notification) => {
  if (notification.method === "session.event" && notification.params.sessionId === this.id) { ... }
  // 其余通知仍会调用 onNotification
}
```

```js
// subscribeSessionTree 实现
subscribeSessionTree(sessionId) {
  return this.subscribe((notification) => {
    if (/* subagent.started / subagent.finished */) { ... isDescendantOf(parentId, sessionId) ... }
    const relatedId = params.sessionId
    return typeof relatedId === "string" && this.isDescendantOf(relatedId, sessionId)
  })
}
```

两个事实：

1. **SDK 订阅的是整棵 Session 树**（`subscribeSessionTree`），
   子 Session（subagent）的事件**也会送达** `onNotification`
2. **通知里带 `params.sessionId`** —— 这才是权威的 Session 身份

因此：

```text
❌ runId ≠ Session 身份
   runId 是一次「执行」的身份；harnessSessionId 才是根 Session 身份
   且同一次执行内的不同子 Session 各自有独立 seq 空间

✅ 去重/排序必须用 (params.sessionId, seq)
✅ 或者：只接收根 Session（过滤 params.sessionId !== 本次 sessionId）
```

**对Phase 1 的要求**：`RuntimeEvent` 必须保留 `params.sessionId` 原生值，
不能用 MindMesh 自己的 `runId` 替代。

> 本次 spike 只产生了一个 Session（未触发 subagent），所以 `seq` 3~30 看起来连续。
> **多 Session 下seq 重叠未实测**，但从 `this.log.length` 逻辑可确定必然重叠。

**`scripts/spike-events.mjs` 已按此修正**：捕获 `params.sessionId`，
并在报告中输出 `sessionIds` 与 `seqRanges`（按 Session 分组的 seq min/max），
作为该结论的可复验证据。
> 多 Session 下 seq 会重叠——**未实测**，但从`this.log.length` 逻辑可确定必然重叠。

### 一个 turn 是否有多个 step（实测：是）

```text
step/start × 3, step/end × 3
step 1 → tool/call(pwsh)
step 2 → tool/call(job_output)
step 3 → 最终回复
```

→ `turn > step > tool_call` 是**真实层级**，不是理论。
Tool Card 可按 step 分组显示；`Execution` 的 step 计数可用于「本次协作第几步」。

### 附带发现：`stream`字段含增量工具参数

`assistant/message.data.stream` 是数组，除常规 chunk 外还有：

```json
{ "type": "tool-call-chunks", "time0":..., "id":"call_00_ET_...",
  "dt":[0,1,33,0,0,...], "args":["{","\"","command","\"",": ", ...] }
```

→ **工具参数是逐 token 流式下发的**（`args` 数组是字符增量）。

这意味着 Phase 1 的 `tool_delta`（工具入参增量）**可以实现**，
数据源就是 `data.stream` 中的 `tool-call-chunks`。

>路线图原写「若 Phase 0 没确认 `tool_delta/tool_output`，一期不自行造事件」。
> **现已确认可得**，但建议**一期仍不做**——先把 `tool_start`/`tool_end` 跑通，
> 增量入参作为二期增强（复杂度：需处理字符增量合并 + JSON 边界）。

---

## S0.2 Usage

### 字段（证据：事件原文 seq=16/22/28）

```json
"usage": {
  "inputTokens": 139,
  "outputTokens": 63,
  "cacheReadTokens": 6016,
  "cacheWriteTokens": 0,
  "totalTokens": 6218
}
```

**路线图 §S0.2 猜测的4 个字段全部存在**，另有 `totalTokens`：

| 字段 | DeepSeek 实测值 |
|---|---|
| `inputTokens` | 139 / 260 / 246 |
| `outputTokens` | 63 / 85 / 12 |
| `cacheReadTokens` | 6016 / 6016 / 6144 |
| `cacheWriteTokens` | **0**（DeepSeek 不写缓存） |
| `totalTokens` | 6218 / 6361 / 6402 |

**恒等式验证**：`input + output + cacheRead = total`
- 139+63+6016 = 6218 ✓
- 260+85+6016 = 6361 ✓
- 246+12+6144 = 6402 ✓

### ✅ 关键结论：usage 是**单次请求**用量，不是累计

实测三个 `assistant/message` 的 usage：

| # | input | output | cacheRead | total |
|---|---|---|---|---|
| 1 (seq=16) | 139 | 63 | 6016 | 6218 |
| 2 (seq=22) | 260 | 85 | 6016 | 6361 |
| 3 (seq=28) | 246 | 12 | 6144 | 6402 |

```text
SUM over 3 = { input: 645, output: 160, cacheRead: 18176 } total = 18981
最后一条 totalTokens = 6402
```

若为累计值，末条应 ≈ SUM（18981）。**实测 6402 ≠ 18981 → 每条独立。**

**因此**：

```text
❌ 不能只取最后一个 assistant/message 的 usage
✅ 必须对所有 assistant/message 的 usage 累加
   （或由 Runtime 在 turn/end 给出汇总——本次未观察到该事件）
```

这直接回答了路线图 §4.6 的三情形中的**情形 B**：

```text
Run.inputTokens / outputTokens / cacheReadTokens   ← 权威原始值（累加得出）
        ↓ SUM
Execution.inputTokens / outputTokens / cacheReadTokens
```

### 其余问题

| 问题 | 实测结论 |
|---|---|
| retry 后是否重置 | **本次未触发 retry**，无法确认。`assistant/attempt` 事件存在（bundle 中 6 次命中）暗示重试会有独立事件，实施时需再测 |
| reasoning token 是否独立 | **未观察到独立字段**。reasoning 内容在 `data.message.content[]` 的 `{type:'reasoning'}` block 中，其 token 可能已计入 `outputTokens` |
| 哪些 Provider 有 cache 数据 | **仅验证 DeepSeek**。`cacheReadTokens=6016` 说明 DeepSeek 支持 cache 读取；`cacheWriteTokens=0` 说明该模型未触发写入。其他 Provider 需另测 |
| usage 出现在哪些事件 | 仅 `assistant/message.data.usage`。`turn/end` / `tool/*` 上**没有** usage |

> **`cacheReadTokens` 数值很高（6016）**：说明系统提示 + 工具定义被缓存。
> 这对成本估算很重要——**缓存读取应单独计价**，不能并入 input。

---

## S0.3 Tool Schema Override

**结论：不支持。**

证据：

- `dsh-sdk-client/lib/index.js` 中 `tool` / `toolset` / `overrideTool` / `listTools` **全部 0 命中**
- `dsh-llm` 中只有工具**调用**相关字段（`toolCallId` / `toolCallArguments` / `toolCallName`），无定义查询接口
- `dsh-fs`、`dsh-bash-local` 中`tool*` 定义模式 0 命中

**含义**：

```text
✅ MindMesh toolCatalog 继续只定义为 Capability Catalog
❌ 无法 override 发给 LLM 的 description / approval policy
```

→ 路线图 §「Tool Catalog 定位」的判断**成立**，无需修改。

---

## S0.4 Deferred Tool Loading

**结论：不存在。**

证据：`dsh-agent-loop/lib/index.js` 中 `tool-(search|defer|load)` 模式 **0 命中**。
全部工具在 `system/message` 中一次性注入。

**含义**：本期不实现，UI 不得显示「按需加载」类承诺。

> MindMesh 现有的 `capabilities.ts` 走cordis patch 禁用工具，
> 那是 **启用/禁用**，不是 **延迟加载**。不要混淆两者。

---

## S0.5 Context / Compaction

### ✅ 可得：`contextWindow`

```json
// request/context 事件原文
{ "provider": "deepseek-official", "model": "deepseek-v4-flash", "contextWindow": 1000000 }
```

→ Composer 的上下文计量环可以从「纯估算上限」升级为「**真实 contextWindow**」。
当前 `model-providers.ts` 的 `contextWindow` 硬编码值与实测一致
（`deepseek-v4-flash` = 1_000_000，L121）。

### ⚠️ compaction 事件：**本轮未触发**，不是「不存在」

> **本节结论已修正**（2026-10-05 复审）。原文写「全部 24 类事件中无 compaction 相关事件」，
> 该结论**只对 `dsh-agent-loop` 一个包成立，不能推广到整个 Runtime**——
> 属于「搜索范围不足导致过度结论」的方法错误。

复审后确认事件**确实存在**，分布在独立插件包中：

| 包 | 事件（实测 grep 计数） | 发出方式 |
|---|---|---|
| `dsh-compaction-basic` | `compaction/start`(2) | ✅ `session.append(...)` → **协议事件** |
| | `compaction/end`(3) | ✅ `session.append(...)` → **协议事件** |
| | `compaction/summary`(1) | ✅ `session.append(...)` → **协议事件** |
| | `compaction/summary-error`(1) | ❌ `ctx.waterfall(...)` → **内部 hook，非协议事件** |
| `dsh-compaction-tool-result-pruner` | `compaction/prune`(1) | 待确认（同一包内，推测为 `session.append`） |

> ⚠️ **不能仅凭字符串命中次数建立事件清单**。
> `compaction/summary-error` 走 `ctx.waterfall`（内部 hook 通道），
> **不会**作为 `session.event` 通知送达，因此**不能**据此认定 Runtime 提供了该事件。
> 上表的「协议事件 / 内部 hook」区分依据是对应的调用点代码，非grep 计数。

**可捕获的协议事件**：`compaction/start`、`compaction/end`、`compaction/summary`
**不可据此断言的**：`compaction/summary-error`（内部 hook）

**为什么本轮没观察到**：本次 spike 请求很短（上下文远未达阈值），
compaction 未被触发，因此事件没有出现。这属于「未触发」，不是「不存在」。

**正确结论**：

```text
✅ compaction 事件在 Runtime 中存在（已由包代码确认）
❌ 本轮未触发，payload 形状与触发时机未验证
⚠️ 不得据本轮结果断言「拿不到 compaction 事件」
```

**仍禁止在 UI 承诺「接近上限会自动压缩」** —— 但理由从「事件不存在」
改为「**触发时机与 payload 未实测**」。

| UI 表述 | 允许？ | 理由 |
|---|---|---|
| 「当前上下文占用约 X%」（基于真实 contextWindow） | ✅ 允许 | `request/context` 已实测 |
| 「接近上限时会自动压缩」 | ❌ 暂不允许 | 触发时机与 payload 未验证 |

### 待补测（Phase 6 前）

构造超长上下文或改用更小的 `contextWindow` 触发压缩，观察：

- `compaction/start` 的 payload 字段
- `compaction/end` / `compaction/summary` 是否携带压缩后摘要
- `compaction/prune` 与 tool result 裁剪的关系
- 压缩后 `usage` 是否额外计入
- 是否可由用户关闭 / 配置阈值

---

## S0.6 FTS5 中文检索复验

开发环境（Node 24.14.0 + `node:sqlite`）实测结论与v5 记录一致：

```text
CREATE VIRTUAL TABLE t USING fts5(content, tokenize='trigram')  → 成功
插入 '人工智能测试'

查询 "智能"     → 0 命中   ❌
查询 "人工"     → 0 命中   ❌
查询 "测试"     → 0 命中   ❌
查询 "人工智能"  → 1 命中   ✅
查询 "人工智"    → 1 命中   ✅
```

对照unicode61：

```text
查询 "智能"     → 0 命中
查询 "人工"     → 0 命中
查询 "人工智能"  → 0 命中   ← 连完整词都搜不到
```

**结论**：trigram **必须** + 2 字查询 **必须**走 `LIKE '%xx%'` 兜底。

**待复验项（Phase 0 遗留）**：打包 runtime（Electron 44 内置 Node）的 FTS5 行为。
本轮未跑打包环境验证，因`release/` 产物可能过期。建议在 Phase 6 前用
`scripts/plugin-resolution-probe.mjs` 同一位置复验一次。

---

## 三、对路线图的修正建议

| # | 位置 | 建议 |
|---|---|---|
| 1 | Phase 1 §6 RuntimeEvent | `arguments` 标注为 **JSON string**，实现时需 `JSON.parse` + 容错 |
| 2 | Phase 1 §4.4 tool_calls | `aborted` 状态确认为**必需**（实测中断产生悬空 call），非防御性设计 |
| 3 | Phase 1 §6 `seq` | ⚠️ 改为「**Runtime 原生，但作用域是 Session**」。去重/排序必须用 **`(params.sessionId, seq)`**，**不可用 runId 替代 Session 身份**（SDK 订阅 Session 树，子 Session seq 独立） |
| 4 | Phase 1 §6 事件列表 | 补 `turn/start`、`step/start`、`step/end`、`turn/end`；忽略 `agent/inbox/spliced`、`session/title`、`session-log-*` |
| 5 | Phase 1 §4.6 Usage | 确定为**情形 B**：Run 存累加原始值，Execution 存 SUM。`totalTokens = input + output + cacheRead` 已验证恒等 |
| 6 | Composer 计量环 | 可接`request/context` 的真实 `contextWindow`；压缩事件**存在但本轮未触发**，同样不得宣称压缩行为 |
| 7 | Phase 1 §8 状态词 | `step/*` 事件存在 → 可显示「第 N 步」；`tool/result.isError` → Tool Card 状态 |
| 8 | Phase 1 一期范围 | `tool_delta`（工具入参增量）**数据源已确认**（`stream[].tool-call-chunks`），但建议二期再做 |
| 9 | Phase 6 前 | 补打包 runtime 的 FTS5 复验 |
| 10 | Phase 6 前 | **补 compaction 实测**：构造超长上下文触发 `compaction/start` / `end` / `summary`，验证 payload 与 `usage` 是否额外计入 |

### 事件映射实现要点（供 Phase 1 直接引用）

```ts
// ⚠️ 身份区分（v9 复审修正）：
//   runId     = MindMesh 本次执行的 ID（一个 Session 可承载多次执行）
//   sessionId = 通知里的原生 params.sessionId（权威 Session 身份）
//   两者**不能**互相替代；同一 Session 内不同子 Session 的 seq 空间独立

// DSH 原生字段 → MindMesh RuntimeEvent
turn/start        → run_start  { sessionId: params.sessionId, runId: <本次执行 ID> }
step/start        → （可选）用于「第 N 步」显示
tool/call         → tool_start  { callId, name, arguments: JSON.parse(data.arguments) }
tool/result       → tool_end{ callId: data.message.toolCallId,
                                   isError: data.message.isError,
                                   text: data.message.content[].text }
assistant/message → text_delta / reasoning_delta + usage 累加
turn/end          → run_end     { reason: data.reason.kind }   ← 终态来源之一（见下）

// 排序键：(params.sessionId, seq)，不可只用 seq，也不能用 runId 代替 Session 身份
// 中断后：残留 tool/call 无对应 result → tool_end { status: 'aborted' }
```

#### 终态判定：三态，**`turn/end` 不是唯一来源**

⚠️ **不要等待 `agent/turn-stopping` 或 `agent/error`** ——
它们是 `dsh-agent-loop` 的**内部信号，SDK 不作为通知转发**
（实测这两个字符串在 `dsh-sdk-client` 中出现 **0 次**）。

⚠️ **也不要假设「主动停止一定会收到 `turn/end`」**——
本报告自己的有效中断记录，事件序列**止于 `tool/call`**，并没有 `turn/end`：

```text
事件序列: ... assistant/message > tool/call     ← 关闭 runtime 后即结束
```

因此终态必须**三态判定**：

| 情形 | 判定 | 依据 |
|---|---|---|
| 收到 `turn/end` | 映射 `data.reason.kind`：`completed` / `aborted` / `error` | `completed` 与 `error` 本次均实测捕获；`aborted` 见 SDK `validatedTurnEndReason` 分支（要求 `reason.reason.kind`） |
| **未收到 `turn/end`，但 stop 确认成功** | 由 **Main 标记** Run 已停止；该 Run 下所有悬空 ToolCall 标记 `aborted` | 关闭 runtime 会直接中断传输，事件流随之终止 |
| `stop()` 返回 `false` | **不得**标记为已停止 | 租约未唯一匹配，runtime 仍在运行，Run 状态未知 → 维持 `running` 并按失败处理 |

**异常路径**：以 `harness.run()` 的 rejection 为准（配合 `code`/`status`），
不要等 `agent/error` 事件。

> 三态之中只有第一态有协议依据。第二、三态必须由 MindMesh 侧根据
> `stop()` 的返回值与本地状态自行判定——**这也是 `stop()` 必须返回 boolean 的原因**。


> 本次 28 个实测事件中**没有** `agent/turn-stopping` / `agent/error`，
> 二者仅存在于 bundle 字符串表中——这正是不能照抄字符串列表建立事件清单的又一例证。


### 需要补充测试的两项

| 项 | 原因 |
|---|---|
| **retry 后的 usage 行为** | 本次未触发。需用 `MINDMESH_SPIKE_MODEL` 指定不稳定模型重试，或构造触发重试的场景 |
| **非 DeepSeek Provider 的 cache 字段** | 只验证了 DeepSeek。Anthropic/OpenAI 的 cache 字段名可能不同 |

---

## 五、环境限制与测试配置（2026-10-05 复审补记）

### `vitest.config.ts` 超时：基于实测而非猜测

复审指出「缺 `testTimeout` 是 P0 根因」属**过度归因**（`plugin-runner.test.ts:79`
本就显式配置了 `15_000`）。按「先取证再配置」的原则实测：

| 用例 | 实测耗时 |
|---|---|
| `capabilities` > parses all repository Agent Skills samples | **36.7s** |
| `capabilities` > rejects legacy invocation keys… | 23.4s |
| `capabilities` > installs a GitHub skill directory… | 8.6s |
| `plugin-runner` > timeout and active cancellation… | 21.8s |
| `database-agent`（整文件） | 25.6s |

这些是**真实工作量**（解析 10 个随包skill bundle、真实 tar 解压、GitHub tarball 下载），
不是挂死。因此设置：

```ts
testTimeout: 60_000     // > 实测最慢 36.7s，留约 1.6x余量
hookTimeout: 60_000
teardownTimeout: 30_000
```

仍远低于「挂死」的量级，不会掩盖真实问题。

**效果**：全量 `Test Files 6 failed | 28 passed` → 修复前 `20 failed | 14 passed`；
`Tests 54 failed | 255 passed` → `9 failed | 300 passed`。

### 剩余 9 个失败的归因（**非**本次改动引入）

| 失败 | 归因 | 证据 |
|---|---|---|
| `dsh-upgrade` 3 项 | **环境**：沙箱禁止子进程 spawn | `spawnSync node.exe EBUSY`（受管 Node 与系统 Node 均复现） |
| `plugin-github` / `plugin-staging` 等 6 项 | **环境**：真实 GitHub 网络下载，67~240s | 单独跑耗时 182s，失败于网络阶段 |
| `plugin-runner` 1 项 | 同 EBUSY | — |

→ 与 Phase 0 改动**无关**：改动仅涉及 `scripts/`、`docs/plans/`、`.gitignore`、`vitest.config.ts`。
`spawnSync EBUSY` 与本轮早前的 `esbuild ... Access is denied` 属**同一类 Windows 进程/文件占用问题**。

> 设置独立 `TEMP` 可规避 esbuild 那次；`spawnSync EBUSY` 未验证是否同样可规避。
> **这两项的精确根因均未确证**，不应据当前证据下结论。


---

## 四、复现方式

```bash
# S0.1 + S0.2：捕获完整事件流（需 DEEPSEEK_API_KEY）
node scripts/spike-events.mjs
#→ logs/spike/s0-notifications.json

# S0.1 悬空验证：中断后检查 tool/call 配对
MINDMESH_SPIKE_INT_DELAY=22000 node scripts/spike-interrupt.mjs
```

两个脚本均为**只读诊断**：

- 只在 `mkdtemp` 临时目录上创建 `DSH_HOME`
- 结束后校验路径仍位于 `tmpdir` 前缀下才递归清理
- 不写入仓库任何文件（输出仅落`logs/spike/`，已在 `.gitignore`）
- 不打印任何密钥

> 注意：脚本会发起**真实模型请求**，产生少量 API 费用。
> `logs/` 已被 `.gitignore` 覆盖（`.gitignore:24` 的 `*.log` 规则 +目录级）。