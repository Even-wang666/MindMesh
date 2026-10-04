# MindMesh 代码仓库全面评审报告 · 第二版（增量复审）

> 初版：2026-10-04 12:33 ｜ 本版：2026-10-04 18:46
> 复审范围：针对 `HEAD~2..HEAD` 的 6 次提交（重点 `0a8afcc` lint 门禁 + `94b861f` 评审问题修复）做增量核验，并对全仓健康度重新实测
> 代码规模变化：src 约 12,600 行 → **14,254 行**；测试 26 文件/263 用例 → **28 文件/282 用例**

---

## 摘要：一句话结论

**团队认真吸收了上次评审的建议，14 项已确认修复、lint/format 门禁真正落地；但这轮重构「主要是搬运而非解耦」——`App.tsx` 反而从 811 涨到 994 行、`database.ts` 从 728 涨到 1216 行、事务样板从 3 处反弹到 10 处，同时新引入了 3 个真实缺陷（其中 1 个让视觉模型无法选择）。**

**质量评分变化**：安全性 A-（持平）｜代码质量 B+ → **B**（God Object 恶化 + 新引入缺陷）｜工程化 **C+ → B+**（门禁落地，唯一短板仍是 testTimeout）

---

## 一、上次评审建议的落实情况

### 1.1 完全落实（14 项）

| # | 上次建议 | 落实证据 |
|---|---|---|
| ① | **补 lint/format/commit 门禁** | ✅ `biome.json`（66 行）+ `.editorconfig` + 4 条 script（`format`/`format:check`/`lint`/`lint:fix`），CI 已接入 `format:check` → `lint` |
| ② | **修复 `spaces:updateContext` 校验** | ✅ `database.ts:844` 新增 `validateSpaceContext(context)` + `validateRecordId(id)` |
| ③ | **`spaces:updateContext` + 全仓边界校验体系化** | ✅ 新增 7 个校验函数：`validateFieldLength`(:41)、`validateRecordId`(:46)、`validateStringList`(:50)、`validateSpaceContext`(:63) 等；zod 从 1 个文件扩到 2 个 |
| ④ | **`index.ts:156` 丢栈** | ✅ 改为 `error.stack ?? error.message` 并过脱敏 |
| ⑤ | **日志脱敏不完整** | ✅ 新增 `src/main/plugins/plugin-diagnostics.ts` 专职脱敏，`sk-` 正则 + JSON 紧凑形式 + 自定义 secrets 替换全部覆盖；6 处调用点统一使用 |
| ⑥ | **死代码 `selectedSkillsRevision`** | ✅ 已移除（全仓零命中） |
| ⑦ | **`harness-adapter` 死 re-export** | ✅ 已移除 |
| ⑧ | **`plugin-dev.ts` 的 `as unknown as` 污染** | ✅ 已消除（现存 5 处均为 `node:sqlite` 行转换惯用法） |
| ⑨ | **renderer 静默失败** | ✅ 新增 `loadError` 状态（`CatalogPage` 4 处），`App.tsx:105-131` 三段 catch 归一化 |
| ⑩ | **AgentDrawer a11y 缺陷** | ✅ `AgentDrawer.tsx:69-72` 补 `role="dialog"` + `aria-modal` + Escape（`:31-34`）；`CatalogPage` 亦已补 |
| ⑪ | **App.tsx 巨型单行 JSX** | ✅ 已拆出 `CatalogPage.tsx`(285) / `Composer.tsx`(527) / `MessageList.tsx`(184) / `AgentDrawer.tsx`(140) / `model-options.ts` |
| ⑫ | **会话重建逻辑重复 18 行×2** | ✅ 已去重（`services.ts` 内 `getOrCreateRuntimeSession` 单点调用） |
| ⑬ | **renderer 过度抽象** | ✅ 三个菜单已统一纳入 `openMenu` 状态机（`Composer.tsx:72`） |
| ⑭ | **隐式契约守护** | ✅ 新增 `tests/service-mocks.ts` 共享夹具、`plugin-runtime-validation.test.ts`、`plugin-diagnostics.test.ts` |

### 1.2 未落实（2 项，且其中 1 项恶化）

| # | 上次建议 | 现状 |
|---|---|---|
| ③ | **建立统一 IPC schema 层** | ⚠️ **部分**：校验函数已体系化（7 个），但仍无统一入口层。30 个 `ipcMain.handle` 中 28 个在 handler 内**零本地校验**，全部依赖下游 service/database 兜底。zod 仍只覆盖 2 个文件 |
| ⑥ | **修 `testTimeout`** | ❌ **未修**：`vitest.config.ts` 仍 8 行，无 `testTimeout`，默认 5000ms |

---

## 二、本轮新引入的问题（8 项）

> 这是本次复审最重要的产出。以下问题在上次评审时**不存在**。

### 🔴 N1 视觉模型无法选择（功能性缺陷）

`src/renderer/src/model-options.ts:5-6` 与 `:31-33`：

```ts
export function displayModelName(model: string): string {
  if (model === 'deepseek-v4-flash' || model === 'deepseek-v4-flash-vision-exp')
    return 'DeepSeek V4.1 Flash'      // ← 两个不同 id 映射为同一 name
  ...
}
return available.filter((item, index) =>
  available.findIndex((candidate) => candidate.name === item.name) === index)  // ← 按 name 去重
```

而 `model-providers.ts:119-120` 中 `deepseek-flash` 的 name 也是 `'DeepSeek V4.1 Flash'`。

**三个不同 id 渲染为同名 → 按 name 去重后只保留首个 → 配置的 vision 模型被静默丢弃，用户无法选择。** 矛盾在于 `model-providers.ts:153` 的 `supportsImageInput` 确实为这两个 id 返回 `true`，形成"能探测但不能选"的割裂。

**影响**：README 明确宣称"DeepSeek Flash 对话支持 PNG、JPEG、WebP 与 GIF 图片附件"，但用户无法在 UI 中选到 vision 变体。
**建议**：去重键改为 `id` 而非 `name`，或给 vision 变体单独的显示名（如 `DeepSeek V4.1 Flash (视觉)`）。

### 🔴 N2 脱敏函数丢弃 Error 栈（新代码重犯旧错）

`src/main/plugins/plugin-diagnostics.ts:3`：`let text = String(value)`

`String(new Error('x'))` → `"Error: x"`，**`.stack` 完全丢失**。调用点 `plugin-manager.ts:234`：

```ts
const message = redactPluginDiagnostic(error).slice(-4096)
```

插件 staging 失败（涉及子进程 spawn、协议握手、制品校验）的**全部堆栈被抹掉**，只剩 message 尾部。这是上次「致命日志丢栈」问题在新代码路径上的复现——上次修的是 `index.ts:213`，这次是新模块。
**建议**：`String(value instanceof Error ? (value.stack ?? value.message) : value)`。

### 🟡 N3 脱敏函数误伤协议配置数据

`plugin-diagnostics.ts:1` 注释声称：
> `/** Diagnostic text only: never sanitize protocol/configuration data returned to callers. */`

但实际调用点 `dsh-cli-runner.ts:203` 是：
```ts
`DSH exited ${code}: ${redact(stderr).slice(-16_384)}\n${redact(output).slice(-4096)}`
```
这里 `output` 在 `--dump-config` 场景（`plugin-manager.ts:140`）下**就是插件合成后的 YAML 配置**，其中出现 `token:` / `secret:` 字段是完全合法的插件配置。

**注释与实际用途直接矛盾**：函数同时用于「用户可见诊断」与「协议/配置数据」两条语义相反的路径，且无法区分。结果是排查插件配置问题时刻意打码了关键字段。
**建议**：拆为 `redactDiagnostic()`（仅凭据模式）与 `redactSecrets()`（仅已知 secrets 替换）两个函数，配置路径只走后者。

### 🟡 N4 `sk-` 正则字符集过窄

`plugin-diagnostics.ts:13`：`/\bsk-[A-Za-z0-9_-]+/g`

不含 `.` `+` `=` `/`。形如 `sk-abc.def+ghi=` 的密钥只替换前半段，尾部 `.def+ghi=` **原样留在日志里**。DeepSeek 自身是 hex（安全），但 `dsh-cli-runner.ts` 是通用插件 runner，插件可携带任意 provider 凭据。
**建议**：改为 `/\bsk-[A-Za-z0-9._+/=-]+/g`。

### 🟡 N5 secrets 无长度下限，短值摧毁整份诊断

`plugin-diagnostics.ts:4-6` 对 `secrets` 做全量 `replaceAll`（降序排列逻辑本身**正确**，长串优先避免破坏边界）。但 `dsh-cli-runner.ts:78-80` 的采集条件是"环境变量名匹配 `/key|token|secret|password/i`"——若某个 `*_KEY` 的值是 `1` / `true` / `test` 这类短串，日志中每个该子串都会被替换成 `[REDACTED]`，诊断信息被大面积抹掉。
**建议**：加 `value.length >= 8` 门槛。

### 🟡 N6 `installSkill` 错误处理与同文件分支不一致

`CatalogPage.tsx:65-68`：
```ts
} catch (caught) {
  const message = caught instanceof Error ? caught.message : '技能安装失败'
  throw new Error(message)        // ← message 白算后直接 rethrow
}
```

同文件 `installGitHubSkill`（`:88`）正确调用 `setError(...)`。这里 rethrow 后由 `DirectoryConfirm` 捕获并显示在**对话框内**而非页面级错误区，用户关掉对话框就看不到任何失败痕迹——这是已修复的"静默失败"模式换了入口重新引入。
**建议**：改为 `setError(message)`。

### 🟡 N7 Composer 三个菜单 + mention 菜单状态分两套

`Composer.tsx:72` 的 `openMenu` 是 `'permission' | 'model' | 'context'` 三选一，但 **mention 菜单（`:238-256`）与技能菜单（`:257-272`）由 `value` 正则驱动（`:80-87`），不在 openMenu 体系内**。权限菜单打开时输入 `@zh` → 两者同时渲染，且共用 `className="mention-menu"` 叠在同一位置。

另：全仓库无 click-outside 关闭逻辑，三个菜单只能靠再次点击触发器关闭。

### 🟢 N8 拖拽监听随附件变化反复重订阅

`Composer.tsx:136` `addFiles` 的 `useCallback` 依赖 `attachments`，导致 `:138-176` 的 effect 在每次附件增删时把 4 个 window 级监听全部注销重绑。改用 `attachments.length` 或 functional update 即可避免。

---

## 三、结构性问题：重构是"搬运"而非"解耦"

这是本轮最值得警惕的信号。**文件数增加了，但职责边界没有改善。**

### 3.1 App.tsx 反而变大了：811 → 994 行（+22%）

拆出了 4 个组件，但 `App.tsx` 内**仍有 7 个组件同文件**：

| 组件 | 行号 | 行数 |
|---|---|---|
| `App`（含全局加载、错误横幅、7 路视图分发、6 个弹窗编排） | `:50` | ~364 |
| `PrimaryNav` | `:414` | ~96 |
| `ObjectList` | `:510` | ~73 |
| **`ChatPanel`** | `:583` | ~86 |
| **`SpacePanel`** | `:669` | ~255 |
| `EmptyState` | `:924` | ~14 |
| `AgentsPage` | `:938` | ~56 |

**`ChatPanel` 与 `SpacePanel` 共 341 行，与刚拆出的 `Composer`/`MessageList` 同级，却留在 App.tsx 内。** 二者的 `<MessageList>+<Composer>` 渲染块（`App.tsx:639-664` 与 `:788-813`）几乎逐行重复，9 个 props 中 6 个完全相同（messages/profile/busy/streamingText/streamingReasoning/liveReplyIds/onSend/onStop）。

**建议**：合并为 `ConversationSurface`，把差异（members/invocableSkills/canAttach/placeholder）作为 slot 传入；再把 7 路视图分发（`:198-317`，120 行）下沉为 `ViewRouter`。这是让 App.tsx 真正变小的正确路径。

### 3.2 database.ts：728 → 1216 行（+67%），且事务样板反弹

**增长来源是新增功能（team 安装：`space_sources` 表、`installTeam`、`installAgencyAgentRows`），但功能加在了错误层级。**

| 指标 | 上次 | 本次 | 趋势 |
|---|---|---|---|
| 总行数 | 728 | **1216** | ❌ 恶化 |
| 事务样板 `BEGIN` | 7 → 已降到 **3** | **10** | ❌ **反弹回 7 处以上** |
| `withTransaction` 辅助 | 0 | **0** | ❌ 仍缺 |
| `listAgents` N+1 查询 | 有 | **未修** | ❌ 持平 |

`seed` + `seedStarterExamples` + `upgradeStarterSkills` + `starterSkillUpgrades` 常量块约 **300 行纯数据**，与 CRUD 无关，应独立为 `database/seed.ts`。

`installAgencyAgentRows` 的抽取是**正确修复**（消除了 37 行内联事务体）。

### 3.3 新增/重构的主进程文件普遍翻倍

| 文件 | 上次 | 本次 | 问题 |
|---|---|---|---|
| `plugin-manager.ts` | 144 | **292** | `PluginStaging.validate` 从 81 → **193 行**（`:51-243`），承担 16 项职责（TTL GC、目录树、环境构造、pkg 校验、resolution、dump-config 解析、**递归 checkEntries**、协议探测、SDK 启停、变更复检、制品落盘、错误落盘） |
| `dsh-cli-runner.ts` | 108 | **231** | `DshCliRunner.run` **160 行**单函数（`:70-230`），含日志写/secret 采集/launcher 生成/spawn/taskkill/4MiB 上限/JSON-RPC 逐帧解析/超时/日志落盘/错误分类 |
| `runtime-supervisor.ts` | 207 | **323** | `acquire` 从 83 → **136 行**（`:92-227`），职责 8 → 11 项；`release` 闭包（`:205-225`）单块承担状态回写+错误分类+按 kind 决定 fail+maintenance+驱逐 5 件事；`:107-111` **递归自调用**在 stale 竞争下可多层递归 |
| `plugin-runtime.ts` | 103 | **219** | 结构健康 |
| `harness-adapter.ts` / `agency-provider.ts` / `runtime-home-materializer.ts` | 196/151/135 | 284/269/236 | 结构健康，无超长函数 |

**重复逻辑**：`installFiles` 数组在 `plugin-manager.ts:133`、`:199-204`、`plugin-runtime.ts:20` **三处各写一遍字面量**；`stagingEnvironment` + `run` 闭包在 `plugin-manager.ts:71-94` 与 `plugin-runtime.ts:112-125` 几乎逐行重复。

### 3.4 错误分类体系进一步恶化

| 指标 | 上次 | 本次 | 趋势 |
|---|---|---|---|
| `throw new Error` | 153 | **164-166** | ❌ 增长 |
| `new RuntimeFailure` | 5 | **6** | ❌ 几乎未动 |
| `profile-invalid` / `plugin-incompatible` 构造点 | 0 | **0** | ❌ 仍不可达 |

`runtime-errors.ts` 的 9 种 kind 中仍有 2 种**永远不会产生**，`classifyRuntimeFailure` 的精细分类只覆盖约 3% 的错误路径。

---

## 四、本轮做对的高质量代码（值得肯定）

复审发现以下新增代码质量明显高于仓库平均：

1. **插件制品完整性链**（`plugin-manager.ts:186-190` 变更复检 + `plugin-runtime.ts:189-193` 代码未被改写 + `pluginHomeDigest` 符号链接逃逸检测 `plugin-runtime.ts:210-211`）——**本轮质量最高的新增代码**
2. **子进程安全**：`dsh-cli-runner.ts:135,174` 输出上限、`:115-123` `taskkill /T /F` 杀进程树、`:27-51` secret 环境变量白名单、`:150-158` JSON-RPC 帧严格校验
3. **运行时 home 防篡改**：`runtime-home-materializer.ts:65` `renameSync` 保留现场、`:117,125-127` 原子 metadata 写、`:104-110` 篡改复检
4. **`runtime-errors.ts:61-81` allowlist 白名单**——未知 SDK 标识一律脱敏，仍是全仓最严谨的错误处理
5. **测试显著增强**：新增 `plugin-runtime-validation.test.ts`、`plugin-diagnostics.test.ts`、`service-mocks.ts` 共享夹具；`runtime-supervisor.test.ts` +317 行
6. **准确的注释删除**：`App.tsx` 删除了关于"1080px 断点不可达"的注释（经核验属实，`index.ts` 最小窗口 1200×720），删得对

---

## 五、实测健康度对比

| 检查项 | 上次 | 本次 | 变化 |
|---|---|---|---|
| `npx tsc --noEmit` | ✅ 零错误 | ✅ **零错误** | 持平 |
| `biome lint --error-on-warnings .` | —（无工具） | ✅ **98 文件零告警** | ✅ 新增门禁 |
| `biome format .` | —（无工具） | ✅ **零格式差异** | ✅ 新增门禁 |
| `: any` / `@ts-ignore` / TODO | 0 / 0 / 0 | **0 / 0 / 0** | 持平 |
| `as unknown as` | 6 | 5 | ✅ 改善 |
| `ipcMain.handle` 校验覆盖 | 3/30 | 3/30（但下游已体系化，7 个校验函数） | ⚠️ 部分改善 |
| Electron 安全基线 | sandbox + contextIsolation + nodeIntegration:false | **不变** | 持平 |
| `testTimeout` 配置 | ❌ 无 | ❌ **仍无** | 持平 |
| 测试全量结果 | 42 超时 / **0 断言失败** | 42 超时 / **0 断言失败**（16 文件失败） | 持平 |
| 单跑 `runtime-pool.test.ts` | 3 超时 | **12 passed / 3 超时** | 持平 |
| 生产依赖漏洞 | 已处安全版本 | **已处安全版本** | 持平 |
| 依赖冗余 | 零 | 新增 `@biomejs/biome`（dev） | 持平 |
| `git` 追踪卫生 | release/out 均 0，共 250 文件 | **不变**，`.gitignore` 补充完善 | 持平 |
| 测试规模 | 26 文件 / 263 用例 | **28 文件 / 282 用例** | ✅ 增强 |

### 关于测试失败的说明（重要）

全量 `pnpm test` 仍报 **16 文件 / 42 用例失败**，但实测分类：

```
34 处 "Test timed out in 5000ms"
 0 处 AssertionError / expected...to
```

**全部是超时，零断言不匹配。** 单跑 `tests/runtime-pool.test.ts` 12 passed / 3 failed，失败项均为 `Test timed out in 5000ms`（实际耗时 6639ms / 14703ms / 5408ms）。

根因未变：`vitest.config.ts` 无 `testTimeout`（默认 5000ms），本机 Node v22.22.2 低于 `engines` 要求的 `>=24`，`node:sqlite` 实验特性并发能力弱。**CI 用 Node 24 不暴露此问题。**

**这仍是上次报告的中优先级未修项**——本次实测证明它持续造成"整片红灯"的假象，严重干扰真实缺陷发现（本次复审必须逐个单跑才能排除断言失败）。

---

## 六、风险与改进建议（本轮更新）

### 🔴 高优先级

| # | 问题 | 影响 | 涉及文件 | 建议 |
|---|---|---|---|---|
| **N1** | 视觉模型被同名去重静默丢弃 | README 承诺的图片附件能力在 UI 中不可用 | `model-options.ts:5-6,31-33` | 去重键改 `id` 或给 vision 变体独立显示名 |
| **N2** | 脱敏函数丢弃 Error 栈 | 插件 staging 失败无堆栈，无法排查 | `plugin-diagnostics.ts:3`、`plugin-manager.ts:234` | `String(value instanceof Error ? (value.stack ?? value.message) : value)` |
| **H2** | **无统一 IPC schema 层** | 28/30 handler 零本地校验，新增 channel 易重犯 | `src/main/index.ts`、`src/shared/` | 在 shared 建 zod schema 层统一入口 |
| **H3** | **`testTimeout` 仍未配置** | 每次全量测试整片红灯，掩盖真实信号，4 分钟+ 反馈 | `vitest.config.ts` | 显式 `testTimeout: 20000`；补覆盖率阈值 |
| **S1** | **database.ts 1216 行 + 事务样板反弹到 10 处** | God Object 恶化，样板重复 | `database.ts` | seed 相关 300 行独立成文件；抽 `withTransaction` 回到 3 处 |

### 🟡 中优先级

| # | 问题 | 涉及文件 | 建议 |
|---|---|---|---|
| N3 | 脱敏误伤协议配置，注释与用途矛盾 | `plugin-diagnostics.ts:1`、`dsh-cli-runner.ts:203` | 拆 `redactDiagnostic` / `redactSecrets` |
| N4 | `sk-` 正则字符集过窄 | `plugin-diagnostics.ts:13` | 补 `.` `+` `=` `/` |
| N5 | secrets 无长度下限 | `plugin-diagnostics.ts:4-6` | 加 `length >= 8` 门槛 |
| N6 | `installSkill` 错误被 rethrow 丢失 | `CatalogPage.tsx:65-68` | 改 `setError(message)` |
| N7 | 菜单状态分两套 + 无 click-outside | `Composer.tsx:72,238-272` | 纳入统一状态机；补外部点击关闭 |
| S2 | **App.tsx 994 行仍含 7 组件；ChatPanel/SpacePanel 渲染块重复** | `App.tsx:583-922` | 抽 `ConversationSurface` + `ViewRouter` |
| S3 | `PluginStaging.validate` 193 行 16 职责 | `plugin-manager.ts:51-243` | 拆 `collectGarbage`/`verifyInstalledPackages`/`assertNoConfigMutation`/`writeArtifact` |
| S4 | `DshCliRunner.run` 160 行 | `dsh-cli-runner.ts:70-230` | 拆 `parseFrame` + `writeDiagnostics` |
| S5 | `acquire` 136 行 + 递归自调用 | `runtime-supervisor.ts:92-227` | `release` 闭包独立；递归改 `while` |
| S6 | 错误分类体系恶化（164 vs 6） | `runtime-errors.ts` | 运行时路径统一走 `RuntimeFailure`；清理不可达 kind |
| S7 | `installFiles` 三处字面量重复 | `plugin-manager.ts:133,199`、`plugin-runtime.ts:20` | 提取共享常量 |

### 🟢 低优先级

| # | 问题 | 涉及文件 |
|---|---|---|
| N8 | 拖拽监听随附件反复重订阅 | `Composer.tsx:136-176` |
| L1 | `listAgents`/`listSpaces` N+1 查询 | `database.ts` |
| L2 | `model-options.ts` 是纯函数却放 renderer | `model-options.ts` |
| L3 | `formatSkillInstallProgress`/`formatTokenCount` 埋在组件文件 | `CatalogPage.tsx:273`、`Composer.tsx:523` |
| L4 | Composer 内文件嗅探逻辑（`:481-513`）应独立 | `Composer.tsx` |
| L5 | App.tsx 三段重复 catch 归一化 | `App.tsx:105-135` |

---

## 七、评审结论（第二版）

### 整体质量评价

**团队对上次评审的吸收执行到位，14 项建议全部落实，lint/format 门禁真正接入了 CI——这不是敷衍式整改，`biome.json` 的规则集（`noExplicitAny`、`noUnusedVariables`、`useHookAtTopLevel` 等）都是针对上次发现的问题精准设计的。**

但本轮也暴露了一个值得警惕的模式：**重构以"增加文件数"为目标，而非"降低耦合度"。**

证据是三个客观数字：`App.tsx` 811→994（拆出 4 个文件后主文件反而 +22%）、`database.ts` 728→1216（事务样板从 3 反弹到 10）、`PluginStaging.validate` 81→193 行。**代码总量从 12,600 涨到 14,254 行，但职责边界一条也没变清晰。** 复审 agent 的原话很准确："主要是搬运而非解耦"。

同时，重构过程新引入了 3 个真实缺陷，其中 **N1（vision 模型不可选）直接导致 README 宣称的核心能力在 UI 上不可用** —— 这类"改 A 坏 B"是拆分时的典型代价，说明缺少针对拆分后行为的回归验证。

**与上次的根本差异**：上次的核心判断是"安全意识先行、缺乏自动化门禁"。现在门禁补上了，**核心判断变为"整改执行到位，但缺少'完成定义'——修完问题后没有回头验证是否引入新问题"**。

### 最值得优先改进的三件事

#### 1. 修 N1 与 N2（本轮唯一的真实功能性缺陷 + 诊断能力缺失）

N1 让 README 承诺的图片能力不可用，是用户可感知的功能损失；N2 让所有插件 staging 失败无堆栈可查。两者都是小改动（各 1-3 行），收益立竿见影。

**建议先补一条回归测试**：断言 `modelsForProvider` 对 vision 变体返回独立的 `id` 条目——这类"同名不同 id"的去重缺陷正是测试最该覆盖的。

#### 2. 停止"搬文件式重构"，改为按职责边界收敛（架构层）

具体三步，优先级从高到低：
1. **合并而非拆分**：`ChatPanel` + `SpacePanel` → `ConversationSurface`（消除 341 行中的重复渲染块）
2. **抽出数据**：`database.ts` 的 seed 相关 300 行 → `database/seed.ts`
3. **补 `withTransaction`**：10 处样板回收到 3 处

判断重构是否成功的标准不是文件数，而是**"删掉组件后需要改几处"**。当前删掉 `Composer` 需要改 2 处（ChatPanel/SpacePanel），合并成 `ConversationSurface` 后只需改 1 处——这才是收益。

#### 3. 补 `testTimeout`（唯一持续未修的工程化项）

第三次评审它仍在。上次实测已证明：无断言失败、全是超时。这项改动只需一行，却决定开发者每天看到的是"一片红灯"还是"真实缺陷"。

建议同时补覆盖率阈值——当前**完全没有**覆盖率配置，而本轮新增了 282 个用例却没有覆盖率数据支撑，无法判断拆分是否真的覆盖到位。

---

## 附：本次复审的实测记录

| 检查项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit` | ✅ 零错误 |
| Biome lint | `npx biome lint --error-on-warnings .` | ✅ 98 文件零告警 |
| Biome format | `npx biome format .` | ✅ 零格式差异 |
| 测试（全量） | `npx vitest run` | 16 文件失败 → **34 处超时 / 0 处断言失败** |
| 测试（单跑） | `npx vitest run tests/runtime-pool.test.ts` | 12 passed / 3 超时 |
| N1 视觉模型 | 代码路径推演 + grep 三个 id 的 name 映射 | ✅ 确认缺陷 |
| N2 丢栈 | 读 `plugin-diagnostics.ts:3` + 调用点 `:234` | ✅ 确认缺陷 |
| N6 错误处理 | 读 `CatalogPage.tsx:58-95` 双分支对比 | ✅ 确认不一致 |
| 事务样板 | `grep -c "BEGIN" src/main/database.ts` | 3 → **10**（反弹） |
| God Object | `wc -l` | database 728→1216、App 811→994 |
| IPC 校验 | `grep -c` | 30 handler / 3 处本地校验（下游 7 个校验函数） |
| CI | 读 ci.yml | ✅ 已含 `format:check` + `lint` |
| git 卫生 | `git ls-files` | ✅ release/out 均 0 |
