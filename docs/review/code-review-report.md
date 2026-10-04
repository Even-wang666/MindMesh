# MindMesh 代码仓库全面评审报告

> 评审日期：2026-10-04 ｜ 评审范围：全量源码（非 diff）｜ 代码规模：src 44 文件 / tests 26 文件 / scripts 15 文件，约 12,600 行  
> 评审方式：静态审查 + 实测执行（typecheck、测试套件、依赖审计、git 追踪核验、敏感信息扫描）+ 三个专项并行审查 agent，结论交叉验证



---

## 一、项目概览

### 1.1 仓库用途

MindMesh 是一款**本地优先的多智能体协作桌面工作台**（Windows 优先）。用户可为每个智能体单独配置身份设定、模型、技能与工具，并把多个智能体放进同一协作空间，通过 `@智能体` 提及控制发言顺序。产品覆盖研究、规划、写作、开发等任务场景。

### 1.2 技术栈

| 层次    | 技术选型                             | 版本                     |
| ----- | -------------------------------- | ---------------------- |
| 运行时   | Electron                         | 44.0.0（固定）             |
| 前端    | React + React DOM                | ^19.1.1                |
| 构建    | electron-vite + Vite             | ^4.0.0 / ^7.0.0        |
| 语言    | TypeScript                       | ^5.7.3（`strict: true`） |
| 打包    | electron-builder（NSIS）           | ^26.0.12               |
| 测试    | Vitest + Testing Library + jsdom | ^3.0.5                 |
| 智能体内核 | `@deepseek-ai/dsh-*` 系列 34 个包    | 0.2.0-rc.2（全锁定 RC）     |
| 插件框架  | `@deepseek-ai/cordis`            | 4.0.4                  |
| 校验    | zod                              | ^3.25.76               |
| 包管理   | pnpm                             | 11.7.0（Corepack 锁定）    |

### 1.3 目录结构与核心模块

```text
src/
├─ main/        Electron 主进程（17 文件）—— 持久化、运行时池、模型服务、技能
│  ├─ index.ts             进程生命周期 + 30 个 IPC handler 注册
│  ├─ database.ts (728行)  SQLite 9 张表 + 迁移 + seed + CRUD  【职责过载】
│  ├─ services.ts (543行)  用例编排（私聊/群聊/设置/模型目录）    【职责过载】
│  ├─ skills.ts (494行)    技能 bundle 读写、manifest 校验、原子替换
│  ├─ runtime-supervisor.ts      进程池租约管理
│  ├─ runtime-home-materializer.ts 运行 home 组装与保留期清理
│  ├─ runtime-errors.ts (58行)   失败分类 + 文案 + JSONL 脱敏日志  【设计最优】
│  └─ plugins/ (6 文件)   插件集合、staging 校验、子进程封装
├─ preload/index.ts (73行)  沙箱 IPC 桥，暴露 34 个受限方法
├─ renderer/src/   React 界面（10 文件）
│  ├─ App.tsx (811行)      路由 + 布局 + 7 类职责  【职责过载】
│  ├─ useChatController.ts 对话状态机 + 三态对账    【质量优秀】
│  ├─ SettingsPage.tsx (290行) / MarketplacePage.tsx / PaneLayout.tsx
│  └─ styles.css (2151行)  124 个 CSS 自定义属性
└─ shared/ (6 文件) 共享类型、IPC 契约、领域逻辑
tests/         26 个测试文件，263 个用例，约 5,400 行
scripts/       15 个构建检查、冒烟测试、截图脚本
docs/          设计文档、法律文本、迁移记录、dsh 版本矩阵（脚本自动生成）
```

**架构分层**（README 声明）：`Renderer → contextBridge → Preload → Main → SQLite / Harness Runtime Pool → Skills / Tools / Models`。实际代码与该声明一致，未发现架构腐化。

---

## 二、架构与代码组织

### 2.1 模块依赖关系

```text
index.ts ──→ database / services / harness-adapter / capabilities
                ↓              ↓            ↓
        model-provider-settings ← runtime-supervisor ← skills
                                    ↓
                        runtime-home-materializer ← capabilities / plugins
services.ts ──→ database / harness-adapter / model-provider-settings
database.ts ──→ agent-capability / plugins/plugin-set / shared/*
plugins/plugin-manager ──→ capabilities / dsh-runtime / cli-runner / plugin-set
```

**总体判断：依赖方向基本正确，无运行时循环依赖。** 数据层未反向依赖 Electron（仅 `model-provider-settings.ts:3` 因密钥加密必须耦合 `safeStorage`，属合理例外）。

### 2.2 存在的层级倒置与耦合问题

**① 数据层 ↔ 插件层循环依赖（硬问题）**

- `src/main/database.ts:10` → `plugins/plugin-set.ts`（取 `pluginSetRevision` 纯函数）
- `src/main/plugins/plugin-set.ts:2` → `database.ts`（`import type` 擦除运行时环）

`pluginSetRevision`（`plugin-set.ts:22`）是纯函数，放在 `plugins/` 下的唯一理由是 `PluginSetManager` 也在该目录。数据层依赖插件领域层是明确的层级倒置。

**② 数据库层承载产品内容**

`database.ts:301-352` 的 `seedStarterExamples` 把 9 个中文启动人设文案硬编码在持久化层。另有 `database.ts:9` 引入 `agent-capability`（运行时能力哈希概念）—— 数据库需要知道"能力哈希"这一运行时抽象。

**③ 中间人（Middle Man）三处**

| 位置                            | 问题                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `capabilities.ts:6`           | 整行 re-export `skills.ts` 的 4 个符号，唯一消费者 `index.ts:8` 走它，而 `harness-adapter.ts:6` 却绕过它直接 `from './skills'` —— **同一 API 两条导入路径** |
| `plugins/plugin-set.ts:35,52` | `snapshot()`/`commit()` 对 `database.readPluginSet()`/`commitPluginSet()` 零加工转发                                                |
| `harness-adapter.ts:14-15`    | re-export `getAgentCapabilityHash`（有消费者）与 `buildProviderSettingsYaml`（**死代码**：实测所有消费者均从 `runtime-home-materializer` 直接导入）     |

**④ 测试替身污染生产代码（硬问题）**

`src/main/plugins/plugin-dev.ts:32`：

```ts
const settings = { getProvider: () => provider, configuredProviders: () => [provider] } as unknown as ModelProviderSettings
```

用 2 个方法伪造出 8 方法的类。其唯一副作用是迫使生产代码在 `services.ts:315`、`:371`、`:377` 三处加入 `typeof x.method === 'function'` 运行时防御——这些检查在类型系统下恒为真，纯粹是测试造成的负担。

### 2.3 职责边界评估

| 模块                      | 行数  | 职责数                                     | 评价                               |
| ----------------------- | --- | --------------------------------------- | -------------------------------- |
| `database.ts`           | 728 | 4（DDL/迁移、seed、6 套 CRUD、插件集合持久化）         | **God Object**，迁移+seed+CRUD 应拆三块 |
| `services.ts`           | 543 | 3（私聊、群聊、设置/模型）                          | 偏胖，可聚合拆分                         |
| `skills.ts`             | 494 | 1（技能管理）                                 | 职责单一，但函数粒度失控（见 3.2）              |
| `App.tsx`               | 811 | 7（数据加载/路由/布局/导航/回调/7 个页面组件/图片嗅探）        | **职责过载**                         |
| `runtime-errors.ts`     | 58  | 1（失败分类）                                 | **设计最好**，但使用率极低（见 3.3）           |
| `runtime-supervisor.ts` | 207 | 1（进程池）                                  | 合理，单函数过重（83 行）                   |
| `capabilities.ts`       | 93  | 4（工具目录/cordis patch/Playwright 探测/技能转发） | 命名误导（叫"能力"实为多职责）                 |

### 2.4 重复代码（8 组，均有实证）

| # | 重复内容                                | 位置 A                                                                         | 位置 B                                 |
| - | ----------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------ |
| 1 | **会话重建判定逻辑（约 18 行逐行同构）**            | `services.ts:147-168`（私聊）                                                    | `services.ts:240-259`（群聊）            |
| 2 | **原子 tmp+rename 替换**                | `skills.ts:338-349`                                                          | `skills.ts:396-411`（**同一文件内**）       |
| 3 | 事务样板 BEGIN/COMMIT/ROLLBACK          | `database.ts` 共 7 处（`:137` `:184` `:432` `:487` `:527` `:559` `:576` `:593`） | 缺 `withTransaction` 抽象               |
| 4 | `installFiles` 数组                   | `plugin-manager.ts:59`, `:95`                                                | `plugin-runtime.ts:11`               |
| 5 | `parseDocument` + `customTags` 逐字重复 | `plugin-manager.ts:64`                                                       | `plugin-runtime.ts:14`               |
| 6 | loopback registry 正则                | `plugin-manager.ts:23`                                                       | `plugin-runtime.ts:54`               |
| 7 | `'https://registry.npmjs.org/'` 字面量 | `dsh-cli-runner.ts:30`, `plugin-manager.ts:51`, `:99`                        | `plugin-runtime.ts:53-54`（共 4 处）     |
| 8 | 弹窗外壳（backdrop + 背景关闭）               | `FilePicker.tsx:71-73`, `:112-114`                                           | `ConfirmDialog.tsx:43-45`（3 份几乎逐字重复） |

---

## 三、代码质量

### 3.1 类型安全（表现优秀）

实测全仓库 `src/`：

| 指标                                | 结果         | 评价                                                       |
| --------------------------------- | ---------- | -------------------------------------------------------- |
| `: any`                           | **0 处**    | 优秀                                                       |
| `@ts-ignore` / `@ts-expect-error` | **0 处**    | 优秀                                                       |
| `as unknown as`                   | 6 处        | 5 处为 `node:sqlite` 行转换惯用法；**1 处是谎言**（`plugin-dev.ts:32`） |
| `as` 断言（renderer）                 | 9 处        | 全部合理（`as const`、CSSProperties 等）                         |
| `TODO` / `FIXME` / `HACK`         | **0 处**    | 无技术债标记残留                                                 |
| 空 catch `catch {}`                | **0 处**    | 所有 catch 均带注释或处理                                         |
| `npx tsc --noEmit`                | **通过，零错误** | 严格模式全绿                                                   |

### 3.2 超长函数（可读性）

| 位置                                                  | 行数                  | 问题                                                                    |
| --------------------------------------------------- | ------------------- | --------------------------------------------------------------------- |
| `skills.ts:215-315` `readSkillBundle`               | **101**             | 12 个 early return；fs 校验+frontmatter 解析+schema 校验+策略推导+收据查找+完整性哈希+展示映射 |
| `services.ts:213-301` `sendSpaceNow`                | **89**              | 6 参数，for 循环内 4 层 try/catch，最深嵌套 5 层（`:266-290`）                       |
| `runtime-supervisor.ts:50-132` `acquire`            | **83**              | 8 项职责，含自我递归（`:67`）                                                    |
| `plugin-manager.ts:29-109` `PluginStaging.validate` | **81**              | 12 个顺序步骤                                                              |
| `database.ts:199-282` `migrate`                     | **84**              | DDL + 6 段 PRAGMA 修补                                                   |
| `App.tsx:488-656` `Composer`                        | **168**             | 11 个 useState，拖拽/权限菜单/模型菜单/mention 菜单混一体                              |
| `App.tsx:780` `CatalogPage` return                  | **单行约 5000 字符 JSX** | 严重可读性问题，含 4 个区块                                                       |
| `Wizards.tsx:99` `SpaceWizard` return               | 单行约 1800 字符         | 同上                                                                    |

### 3.3 错误处理（体系名存实亡）

实测：`throw new Error(` 共 **153 处**，`new RuntimeFailure(` 仅 **5 处**。

`src/main/runtime-errors.ts` 设计相当完善——9 种 `RuntimeFailureKind`、`classifyRuntimeFailure` 分类函数、`runtimeFailureDetail` 中文文案映射、`appendRuntimeError` 带白名单脱敏。但：

- **`profile-invalid` 和 `plugin-incompatible` 两个 kind 全仓库零构造点**（仅出现在 `runtime-errors.ts:4` 类型定义与 `:31-32` 文案表）。实际发生地 `runtime-home-materializer.ts:23`（`Invalid runtime home key`）与 `dsh-cli-runner.ts:100`（`Plugin compatibility validation failed`）都抛裸 `Error`。
- `harness-adapter.ts:173` `throw new Error('模型未返回正文')` 位于运行时路径，会被分类为 `'unknown'`，丢失"协议层空响应"这一事实。
- 结论：**精心设计的错误分类体系只覆盖约 3% 的错误路径**，其余 153 处裸 `Error`（多为中文用户提示）完全在体系之外。

**具体缺陷**：

| 位置                       | 问题                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts:156`           | `console.error(String(error))` —— `String(new Error('x'))` 得 `"Error: x"`，**丢栈**。这是应用唯一致命路径日志                                                                                        |
| `agency-provider.ts:150` | `catch { throw new Error('安装智能体失败，请刷新目录后重试。') }` —— 丢弃全部 `cause`（404 / tar 损坏 / DB 约束失败压成同一句话）。同库内 `plugin-manager.ts:107`、`dsh-cli-runner.ts:61` 均正确使用 `{ cause: error }`，**写法不一致** |
| `services.ts:132`        | `catch { return fallback }` —— 模型列表拉取失败静默降级为静态目录                                                                                                                                     |
| `services.ts:345-347`    | `catch { this.deepSeekBalanceError = true }` —— 余额失败坍缩为布尔，无原因                                                                                                                        |
| `plugin-runtime.ts:69`   | `storedPatch[0].config!.customSkillDirs![0]` —— **三层链式非空断言作用于外部 YAML，零校验**，异常时抛 `TypeError`，最终变成无信息量的 `RuntimeFailure('materialization')`                                            |
| `database.ts:178`        | `(meta.get('plugin_set_generation') as { value: string }).value` 无 undefined 守卫，而**同一函数下一行** `:179-180` 对 `artifact` 做了 `artifact ? ... : null` 守卫                                   |

**注释式空 catch 约 12 处**（`services.ts:354`、`:367`、`index.ts:172`、`plugin-set.ts:53`、`runtime-supervisor.ts:129`、`:202`、`navigation.ts:13` 等）均带解释性说明，属**有意识的设计，质量高于平均**。

### 3.4 日志

**硬问题：无日志抽象，4 个 sink 且无级别体系。**

| Sink                   | 位置                                                      | 级别  |
| ---------------------- | ------------------------------------------------------- | --- |
| `console.error`        | `index.ts:156`                                          | 仅致命 |
| `runtime-errors.jsonl` | `runtime-errors.ts:57` `appendFileSync`                 | 无区分 |
| `result.json`          | `plugin-dev.ts:46`/`:48`、`plugin-manager.ts:102`/`:106` | 无区分 |
| 每次运行的 CLI 日志文件         | `dsh-cli-runner.ts:60`                                  | 无区分 |

`runtime-errors.ts:39-57` 是**全仓库唯一结构化日志**：显式 `safeNames` 白名单、`safeCodes` 白名单、status 范围校验，且**从不写 `error.message`**。这是正确做法，但无其他 sink 效仿。

**日志脱敏缺陷**：

- `plugin-dev.ts:48` `String(error)` **未脱敏**写入 `result.json`。
- `plugin-manager.ts:105` 正则 `/(bearer\s+|api[_-]?key[=:]\s*)[^\s,]+/gi` 不覆盖裸 `sk-xxx` token，也不覆盖 JSON 紧凑写法 `"apiKey":"sk-xxx"`（含引号，与 `key[=:]` 不匹配）。

### 3.5 命名问题

| 位置                            | 问题                                                                          |
| ----------------------------- | --------------------------------------------------------------------------- |
| `marketplace.ts:11`           | `function text(value, limit)` —— 名为 `text`，实为"清洗并截断控制字符"。典型 Mysterious Name |
| `runtime-supervisor.ts:16`    | `RuntimeOwner` 名字说"所有者"，实为"租约身份"；真正 owner 是 `RuntimeEntry.owners`（`:27`）    |
| `plugins/dsh-cli-runner.ts:7` | `readonly cli: string` 实为 pnpm 可执行文件路径，无法区分 dsh-cli 与 package-manager-cli   |
| `plugin-manager.ts:16`        | `const ttlMs` 模块级常量用小驼峰，与 `MAX_BUNDLE_BYTES` 风格冲突；语义是 staging 保留期而非 TTY ttl |
| `database.ts:14` vs `:108`    | `RuntimeSessionRow` 与 `RuntimeSession` 两个近乎同形类型，仅 `agent` 字段有无              |
| `capabilities.ts`             | 命名暗示"能力"，实含工具目录/运行时 patch/环境探测/技能安装四职责                                      |

**硬编码模型 ID 分散 3 处**：`services.ts:28`、`services.ts:129`、`shared/model-providers.ts:88`/`:96`。

### 3.6 魔法数字与文案分叉

| 位置                                                                     | 问题                                                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `services.ts:171`                                                      | `.slice(-31, -1)` —— 31 是历史窗口，无常量名无注释                                                                 |
| `runtime-supervisor.ts:92` 与 `runtime-home-materializer.ts:120`/`:132` | `maxTokens: 8192`、`contextWindow: 131072` 两处独立硬编码                                                     |
| `skills.ts:380-381`、`skill-github.ts:74`                               | 用 `MAX_BUNDLE_FILES` 却把 `16 MiB` 写死在错误文案里 —— **常量与文案双写，漂移风险**                                         |
| `database.ts:542` vs `:544`                                            | 上限 `1_500_000`，报错却说"不超过 1 MB"（自相矛盾）                                                                   |
| `App.tsx:529`/`:531`                                                   | `MAX_IMAGE_BYTES = 32*1024*1024` 已抽常量，但文案硬编码 `'32 MiB'`，`FilePicker.tsx:125-129` 已有 `formatBytes` 可复用 |
| `App.tsx:704-707`                                                      | `estimateContextTokens`: `characters / 2`，无依据注释                                                       |

### 3.7 过度抽象（违反项目 codx.md"推测性能力暂不实现"）

| 位置                     | 问题                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `marketplace.ts:37-41` | `defaultProviders`（3 个 hardcode 空 loader），唯一生产调用点 `index.ts:60-63` 总是显式传参覆盖；`:36` 注释坦承是占位                                         |
| `skills.ts:202-204`    | `selectedSkillsRevision` 已 export，**全仓库零调用**（实测确认）                                                                                |
| `skills.ts:41-59`      | `SkillManifest` + `raw` + `manifest?` 全部在 IPC 边界被剥离（`index.ts:102-105` 只取 11 字段），每次 `listSkillCatalog` 构造完整 manifest 后扔掉，唯一消费者是测试 |
| `runtime-errors.ts:4`  | 两个永不产生的 `RuntimeFailureKind`                                                                                                      |



---

## 四、安全性

### 4.1 敏感信息（结论：无泄露）

实测扫描 `src/ scripts/ tests/ docs/ resources/`：

| 模式 | 命中 | 判定 |
|---|---|---|
| `sk-[A-Za-z0-9]{20,}` | `model-providers.ts:21,27,38`、`tests/model-provider-settings.test.ts:22-23` | **全部为占位符**（`sk-0123456789abcdef...`），非真实密钥 |
| `BEGIN * PRIVATE KEY` | 0 | 干净 |
| `Bearer <20+字符>` | 0 | 干净 |
| key/secret/token/password 硬编码赋值 | 0（排除 `process.env` 与占位符后） | 干净 |

密钥存储链路已验证：`model-provider-settings.ts:110,125,164` 使用 `safeStorage.isEncryptionAvailable()` + `encryptString()`，不可用时直接抛错而非降级明文。README 声明属实。

### 4.2 Electron 安全基线（配置扎实）

`src/main/index.ts:44-46`：`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false` —— **三项关键防护全开**。

CSP（`src/renderer/index.html:7`）：
```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; connect-src 'self' ws://localhost:* ws://127.0.0.1:*;
object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'
```
- ✅ **无 `unsafe-eval`**（关键）
- ✅ `object-src` / `base-uri` / `form-action` / `frame-src` 全部 `'none'`
- ⚠️ `style-src 'unsafe-inline'` 为动态 CSS 变量所必需，可接受
- ⚠️ `connect-src` 放行 `ws://localhost:*` **任意端口**，生产应收紧

`src/main/navigation.ts`：`will-navigate` 白名单 + `setWindowOpenHandler` 仅放行 http/https 走 `shell.openExternal`，其余 `deny`。防护完整。

XSS：全仓库 **0 处 `dangerouslySetInnerHTML`**；`ReactMarkdown` 配置 `skipHtml` + `disallowedElements`，自定义 `a` 组件加 `rel="noopener noreferrer"`；测试 `app-details.test.tsx:1035-1047` 主动投喂 `javascript:` 链接与 `<img onerror>` 验证被过滤。

### 4.3 输入校验缺口（**最高优先级安全问题**）

`src/main/index.ts` 注册 **30 个 `ipcMain.handle`，全文件仅 3 处 `typeof` 校验**（`:90`、`:109`、`:114`）。preload 侧 34 个方法中仅 2 个 chat 通道做校验。

**`spaces:updateContext` 零校验直写数据库（硬问题）**：

```ts
// src/main/index.ts:80
ipcMain.handle('spaces:updateContext', (_event, id, context) => current.updateSpaceContext(id, context))

// src/main/database.ts:551-555
updateSpaceContext(id: string, context: string): Space {
  const result = this.db.prepare('UPDATE spaces SET context = ? WHERE id = ?').run(context, id)
```

`context` 无长度、无类型校验直达 SQL。同一类参数 `chat:stop` 的 scope 有校验（`services.ts:58`），`chat:messages` 没有（`index.ts:81`）—— **同类参数两种待遇**。此问题直接违反 `codx.md`"输入边界验证不得被简化掉"。

### 4.4 SQL 注入（结论：无风险）

所有用户数据走 `?` 绑定参数。模板字面量 `prepare()` 调用（`database.ts:420`/`:442`/`:454`/`:470`/`:546`/`:612` 等）内部全为静态 SQL；`exec(\`...\`)` 为静态 DDL。唯一动态路径 `database.ts:136` `VACUUM INTO ?` 亦为绑定参数。`LIKE` 模式（`:361`/`:374`/`:489`/`:596`）将 `id` 插入**参数值**而非 SQL 文本。

### 4.5 权限与文件访问

| 机制 | 位置 | 评价 |
|---|---|---|
| 文件写入限制在工作目录 | README 声明 | 运行时 home 以 `mode: 0o600` 写入（`runtime-home-materializer.ts:63`/`:72`） |
| Shell 双重开关 | 智能体配置 + 当轮权限 | 需两处同时允许 |
| staging 环境变量白名单 | `dsh-cli-runner.ts:21-31` | 占位符 `mindmesh-staging-placeholder`，**不含任何真实凭据**，设计正确 |
| API Key 进入子进程 | `runtime-supervisor.ts:84-91` | 仅通过 env 传入，**从不记录**，正确 |

### 4.6 敏感数据进入 renderer 的风险

API Key 仅在 `SettingsPage.tsx:105` 的组件 state 中短暂存在，提交后立即重置。`localStorage` 全仓库仅 3 处（`PaneLayout.tsx:47`/`:57`/`:58`），只存面板比例，**不存 Key**。renderer 无 `console.*`。

⚠️ 但 `SettingsPage.tsx:249` UI 承诺"API Key 经过系统加密"，而 preload/contracts 层**无任何 `encrypted` 标志位**，renderer 侧无法核验该承诺。

### 4.7 数据层其他发现

| 位置 | 问题 |
|---|---|
| `database.ts:199-282` `migrate()` | 6 段 `PRAGMA table_info` + `ALTER TABLE` 修补**只对 v0 数据库执行**，而 v0 正是本版本首次创建的（`CREATE TABLE IF NOT EXISTS` 已含全部列）——对所有真实安装是**死代码** |
| `database.ts:148` | `runtime_schema_version='2'` 写入后**从未被读取**；与代码侧 `runtime-revision.ts:8` 的 `RUNTIME_SCHEMA_VERSION` 无任何校验关联 |
| `database.ts:132` | `version > 3` 硬抛 `Unsupported database schema version`，无当前版本、无文件路径、无恢复路径 |
| `database.ts:682-695` | `addMessage` 的 `MAX(sequence)+1` 与 `INSERT` 之间**无事务**，靠 UNIQUE 索引兜底。同一 space 并发发言会撞约束抛原始 SQLite 错误（未映射为用户可读文案） |
| `database.ts:482` | `agents.name` UNIQUE 约束冲突无错误映射（应用层有友好文案但 TOCTOU），抛原始 SQLite 错误 |
| `database.ts:398-401` | `mapAgentRow` 每行额外查一次 `agent_sources`（`:415`），`listAgents()` 是 **N+1 查询** |
| `database.ts:486-497` | `removeAgent` 不删除该 agent 的消息（私聊与 space 两侧都不删），删除后以冗余 `authorName` 继续渲染。可能有意但无注释 |
| `database.ts:669-675` | `saveRuntimeSessionProgress` 无事务，其乐观并发检查的 `result.changes` 被丢弃 → 更新丢失静默无感知 |

---

## 五、依赖管理

### 5.1 依赖冗余（结论：零冗余）

实测脚本遍历全部 60 个依赖逐个 `grep -rlF` 搜索 `src/ scripts/ tests/`，**未发现任何声明但未使用的依赖**。

- `@playwright/mcp` 虽在 `dependencies` 而非 `devDependencies`，但它是运行时由用户插入的浏览器 MCP，`asarUnpack: node_modules/**/*` 且 `scripts/check-packaged-deps.mjs:19` 显式校验其打包版本 —— **划分正确**。
- `pnpm` 11.7.0 同时在 `devDependencies` 与 `packageManager`：**必需的合理双态**。`packageManager` 供 Corepack 锁定开发机版本；`devDependencies` 供 `extraResources` 打进安装包供终端用户安装插件（实测 `release/.../package-manager/pnpm/package.json` version = `11.7.0`，`check-packaged-deps.mjs:13` 强校验）。

### 5.2 漏洞风险（**修正审计工具的过时结论**）

审计工具报告 13 项（9 high / 4 moderate），但**逐一核验 lock 文件后确认生产依赖实际处于安全版本**：

| 报告的漏洞包 | lock 实际锁定 | 结论 |
|---|---|---|
| `http-cache-semantics` 4.1.1（high） | **4.2.0**（已修复） | ❌ 误报 |
| `fflate`（moderate） | **0.8.3**（已修复） | ❌ 误报 |
| `pnpm` ×4（high） | 11.7.0 | ⚠️ 待确认，但为构建期工具 |
| `sharp`（high） | 0.34.4 / 0.35.4 混合 | ⚠️ dev 依赖 |
| `ansi-regex` / `semver` / `ejs`（high/moderate） | — | ⚠️ 均为 dev 传递依赖 |

**生产依赖无已知高危漏洞。** 这是重要修正——不应基于过时审计数据升级生产依赖。

### 5.3 RC 依赖风险（中等）

34 个 `@deepseek-ai/*` 全部锁死 `0.2.0-rc.2`。缓解措施做得相当扎实：
- `scripts/check-dsh-dependency-matrix.mjs` 强制 direct 依赖必须 exact 版本、校验 installed == requested、遍历 **533 个传递实例**验证 peer 一致性
- 实测输出"required dependency/peer 校验失败: 0"
- 自动生成 `docs/dsh-version-matrix.md`（34 direct + 533 传递，含 peer 要求），**杜绝文档腐化**，这是仓库最有价值的文档实践

**但 RC 版本无 SemVer 安全网**：上游 breaking change 只能靠人工跟版；34 个包同版本号意味着一次上游重发即全量变更。建议制定 RC → 稳定版升级预案与回归清单。

### 5.4 锁定文件

`pnpm-lock.yaml` 已提交，`lockfileVersion: '9.0'`，含 `overrides: '@electron/get': 5.1.0` 与 `allowBuilds` 白名单（8 个原生包）—— 供应链构建面控制良好。CI 使用 `--frozen-lockfile` 强制一致。

### 5.5 依赖版本落后

`pnpm outdated` 显示 15 项落后：`typescript 5.7.3→7.0.2`、`vitest 3.2.7→5.0.3`、`vite 7.3.6→8.3.2`、`electron-vite 4.0.0→5.0.0`、`zod 3.25.76→4.6.5`（破坏性主版本）、`@types/node 24→26`。属常规节奏，非紧急。

---

## 六、测试与工程化

### 6.1 测试实测结果（**重要修正**）

| 运行方式 | 结果 |
|---|---|
| 全量并行 | 15 文件失败 / 42 用例失败，耗时 245s，出现 4 次 `Timeout calling "onTaskUpdate"` |
| **单文件 `database-agent.test.ts`** | **22/22 全绿**（20.99s） |
| **单跑 `runtime-pool.test.ts` 等** | 断言全部通过，5 个用例失败信息均为 `Test timed out in 5000ms`，实际耗时 6366ms / 7011ms / 7673ms / 8469ms |

**根因诊断（已闭环验证）**：`vitest.config.ts` 仅 6 行，**未设置 `testTimeout`**，使用默认 5000ms。本机 Node v22.22.2 而 `package.json` 要求 `>=24.0.0`，`node:sqlite` 为实验特性且并发能力弱，重负载测试耗时超过阈值。

**结论：这不是代码缺陷，是测试超时阈值与环境不匹配。** 零个断言不匹配 —— 全部是超时。CI 使用 Node 24 不会暴露此问题。

**但这是真实的工程化缺陷**：测试时间预算未随环境显式声明，导致"15 个文件失败"的假象，掩盖真实信号，且严重拖慢本地开发反馈（单次全量 4 分钟以上）。**建议 `vitest.config.ts` 显式设置 `testTimeout: 20000`（或按环境变量区分）。**

### 6.2 测试质量（显著高于平均）

**`tests/app-details.test.tsx`（1250 行）—— 真正的行为测试**：
- 零 `toMatchSnapshot()`、零 `innerHTML` 快照
- 全部使用面向可访问性的查询（`getByRole('button',{name:'设置'})` 等），抗重构
- **大量断言真实失败路径**：`:127-150` 安装失败后按钮恢复、`:480-494` 保存失败后草稿不清空、`:521-534` 删除失败后弹窗保持打开、`:857-908` 发送失败三态对账
- `it.each` 覆盖 private/space × during/after 四种时序竞态（`:910-934`）
- 扣分项：约 8% 为实现细节断言（`querySelector('.profile-avatar img')`、`compareDocumentPosition`），重构会假失败

**`tests/pane-shares.test.ts`（103 行）—— 纯函数不变式测试典范**：每个用例名描述不变式（"断言 nav+list 之和不变"、"断言内容栏 ≥380px"）；`:4-7` 用注释显式声明"字面量故意硬编码，改样式表要同步此测试"，把隐式契约变成显式告警。

**`tests/preload-security.test.ts`（72 行）—— 覆盖面不足**：`:29` 传入 JSON 字符串 key 并断言原样转发，实际上**把"缺少校验"固化为期望行为**；`pickSkillDir`/`installSkill` 路径无任何校验断言。

### 6.3 覆盖率

**无任何阈值**：`vitest.config.ts` 仅 6 行（include/exclude/environment），全仓库无 `@vitest/coverage-*` 依赖，CI 无 coverage 步骤。

规模尚可：26 个测试文件 / 263 用例 / 约 5,400 行测试 vs 44 个源文件。测试**不依赖真实网络**（`capabilities.test.ts:169` 对 GitHub API 做 stub，API key 均为夹具），**CI 可用性无问题**。

### 6.4 CI/CD（配置优秀）

`.github/workflows/ci.yml`，2 个 job：

| job | 平台 | 步骤 |
|---|---|---|
| `check` | ubuntu-latest | `--frozen-lockfile` → `check:dsh-deps` → `typecheck` → `test` → `build` |
| `windows-package` | windows-latest | `package:dir` → `check:package-deps` → **打包产物真实 Electron 插件冒烟** → **打包产物安全边界冒烟**（`--security-only`） |

亮点：`permissions: contents: read` 最小权限、`timeout-minutes` 兜底、action 全部钉 major 版本、**对打包后的真实产物做安全边界测试**（这是很多项目缺失的）。

**缺口**：无 Dependabot/Renovate、无 `pnpm audit` 门禁、无 coverage 门禁、无 release 发布工作流、无 CODEOWNERS、无 commitlint（commit 规范靠人工）。

### 6.5 工程化配置（**最实在的缺口**）

实测以下配置**全部缺失**：

```
缺失: eslint.config.js / .eslintrc / .prettierrc / biome.json
缺失: .editorconfig / commitlint.config.js / .husky / lint-staged
```

**代码风格与提交门禁完全靠人工**。`package.json` 18 条 scripts 命名规范（`check:*` / `smoke:*` / `poc:*` / `package:*`），但**缺 `lint` / `format` / `clean` / `test:coverage`**。这是本次审查最实在的工程化短板。

其他配置：
- `tsconfig.json`：`strict: true`、ES2022、`skipLibCheck: true` 合理；缺 `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`
- `electron.vite.config.ts`：仅 11 行，三段式 main/preload/renderer，`externalizeDepsPlugin()` 正确，preload 强制 CJS 符合 Electron 44 要求；未配置 minify/sourcemap/chunk 分包
- `scripts/runtime-dependencies.mjs`：复用 electron-builder 内置 semver（零新增依赖）、边界检查防越界 —— 工程质量亮点
- `scripts/check-packaged-deps.mjs`：额外校验 bundled pnpm 载荷完整性、禁止回退到工作区 node_modules

### 6.6 版本控制卫生（结论：优秀）

实测 `git ls-files`：

```
release/ → 0    out/ → 0    logs/ → 0    shots/ → 0    node_modules/ → 0
总追踪文件：250
```

`release/` 磁盘上有 1007 个文件，但 `.gitignore` 已正确排除 —— **构建产物零污染**。

瑕疵：`shots/` 未整体忽略（仅 `shots/.chrome-*/`）；`git status` 显示 2 个未追踪的 `electron.vite.config.*.mjs`（Vite 临时产物）；`.workbuddy/` 未忽略。

### 6.7 文档完整度（较好）

`docs/` 结构良好：design（tokens/概念图）、legal（中英隐私+用户协议）、migration（8 篇）、plans（3 篇）、screenshots、`dsh-version-matrix.md`（脚本自动生成）。

抽查一致性 3 个关键点全部吻合：技术栈（Electron/React）、DSH 集成（`dsh-runtime.ts` + `harness-adapter.ts`）、SQLite 存储（`database.ts` + `node:sqlite`）。

缺口：无 `CONTRIBUTING.md`（`AGENTS.md` 仅 256 字节极简）、无架构 ADR、无契约文档、`THIRD_PARTY_NOTICES.md` 仅 3894 字节且只覆盖 2 个 skills 来源，**未包含 34 个 DSH 生产依赖的许可证**（合规不完整）、根目录三份 V1.0 方案文档未标注是否已实现。

---

## 七、风险与改进建议

### 🔴 高优先级

| # | 问题 | 影响 | 涉及文件 | 建议做法 |
|---|---|---|---|---|
| H1 | **`spaces:updateContext` IPC 输入零校验直写数据库** | 违反 codx.md 边界校验要求；沙箱 renderer 可写入任意大小字符串，存在内存/存储放大风险 | `src/main/index.ts:80`、`src/main/database.ts:551-555` | 增加长度上限与类型校验；建议在 preload 与 service 两层同时设限 |
| H2 | **30 个 IPC handler 仅 3 处 `typeof` 校验，zod 仅覆盖 1 个文件** | 校验散落各文件、无统一入口，新增 channel 易遗漏 | `src/main/index.ts:64-129`、`database.ts`、`services.ts` | 在 `src/shared/` 建立 IPC 入参 schema 层，handler 统一走 schema 解析 |
| H3 | **测试超时阈值未配置，全量测试产生"15 文件失败"假象** | 掩盖真实信号，严重拖慢反馈（单次 4 分钟+） | `vitest.config.ts`（仅 6 行，无 `testTimeout`） | 显式设置 `testTimeout: 20000`；或按环境区分；补覆盖率阈值 |
| H4 | **零 lint/format/commit 门禁** | 代码风格与提交规范完全靠人工；重命名、重构缺乏安全网 | 仓库根（eslint/prettier/biome/commitlint/husky 全缺失） | 引入 ESLint flat config + Prettier，接入 CI 与 husky pre-commit |
| H5 | **34 个生产依赖锁定在 RC 版本** | 上游 breaking change 无 SemVer 安全网，一次重发即全量变更 | `package.json:32-65` | 制定 RC → 稳定版升级预案与回归清单；保持 `check-dsh-deps` 强制校验 |


### 🟡 中优先级

| # | 问题 | 影响 | 涉及文件 | 建议做法 |
|---|---|---|---|---|
| M1 | **`plugin-dev.ts:32` 的 `as unknown as` 污染生产代码** | 迫使 `services.ts:315`/`:371`/`:377` 三处加入恒真 `typeof` 防御 | `plugins/plugin-dev.ts:32`、`services.ts:315,371,377` | 改用真实 stub 实现或依赖注入，删除三处防御 |
| M2 | **错误分类体系名存实亡** | 153 处裸 `Error` vs 5 处 `RuntimeFailure`；两个 kind 零构造点，运行时故障定位困难 | `runtime-errors.ts:4`、`harness-adapter.ts:173`、`runtime-home-materializer.ts:23`、`dsh-cli-runner.ts:100` | 运行时路径的错误统一走 `RuntimeFailure`；删除不可达 kind 或补齐构造点 |
| M3 | **致命路径日志丢栈** | 应用崩溃时无堆栈，无法定位 | `src/main/index.ts:156` | 改用 `console.error(error)` 或 `error.stack` |
| M4 | **数据库层承载产品文案与运行时概念** | 层级倒置；`database.ts` 728 行 God Object | `database.ts:301-352`（seed）、`database.ts:9`、`database.ts:10` | seed 内容迁到独立 fixture 文件；`pluginSetRevision` 上移到 shared |
| M5 | **会话重建逻辑重复 18 行** | 双聊模式需同步改两处，易漏 | `services.ts:147-168` vs `:240-259` | 抽取共用函数，参数化差异点 |
| M6 | **迁移体系存在死代码与失效版本号** | `migrate()` 6 段修补对真实安装永不执行；`runtime_schema_version` 写入后从不读取 | `database.ts:199-282`、`:148`、`runtime-revision.ts:8` | 拆分 `createSchema` 与 `migrateLegacy`；建立 DB 版本与 runtime schema 版本的校验关联 |
| M7 | **`plugin-runtime.ts:69` 三层链式非空断言** | 外部 YAML 异常时抛 `TypeError`，信息全失 | `plugins/plugin-runtime.ts:69` | 改为显式校验 + 带上下文的错误 |
| M8 | **日志脱敏不完整** | `plugin-dev.ts:48` 未脱敏写文件；正则不覆盖 JSON 紧凑形式与裸 `sk-` | `plugins/plugin-dev.ts:48`、`plugins/plugin-manager.ts:105` | 抽出统一 `redact()` 供全部 sink 使用，参照 `runtime-errors.ts:39-57` 的白名单模式 |
| M9 | **`App.tsx` 职责过载 + 巨型单行 JSX** | 811 行 7 类职责；`CatalogPage` return 单行约 5000 字符 | `App.tsx:33-811`、`:780`、`Composer :488-656` | 抽出 `CatalogPage`/`Composer` 子组件与 `useImageDrop`；`App.tsx:123-148` 的 inline async 回调补 try/catch |
| M10 | **a11y 缺陷：AgentDrawer 键盘不可关闭** | 无 `role="dialog"`、无 Escape、无焦点管理，纯鼠标可达 | `App.tsx:810`（AgentDrawer） | 补 `role="dialog"` + `aria-modal` + Escape 关闭 + 焦点归还 |
| M11 | **renderer 存在静默失败** | 用户看到"没有技能"/空列表却不知原因；`App.tsx:732` 完全无 catch → 白屏 | `App.tsx:74`、`:79`、`:732`、`SettingsPage.tsx:114-115` | 统一错误提示；补 `.catch` 与用户可见反馈 |
| M12 | **`THIRD_PARTY_NOTICES.md` 合规不完整** | 34 个 DSH 生产依赖许可证未纳入 | `THIRD_PARTY_NOTICES.md`（3894 字节） | 扩展覆盖全部生产依赖 |

### 🟢 低优先级

| # | 问题 | 涉及文件 | 建议做法 |
|---|---|---|---|
| L1 | 过度抽象违反 codx.md | `marketplace.ts:37-41`（占位）、`skills.ts:202-204`（零调用）、`skills.ts:41-59`（IPC 剥离） | 删除死代码与占位实现 |
| L2 | 中间人与双导入路径 | `capabilities.ts:6`、`plugins/plugin-set.ts:35,52`、`harness-adapter.ts:14-15` | 统一技能 API 导入路径；删除零加工转发与死 re-export |
| L3 | 重复代码 8 组 | 见 2.4 表 | 抽 `withTransaction`、`parseYamlWithDshTags`、共享常量 |
| L4 | 常量与文案双写漂移 | `skills.ts:380`、`skill-github.ts:74`、`database.ts:542,544`、`App.tsx:529` | 文案从常量派生（复用 `formatBytes`） |
| L5 | 命名问题 6 处 | `marketplace.ts:11`、`runtime-supervisor.ts:16`、`dsh-cli-runner.ts:7` 等 | 见 3.5 表 |
| L6 | `styles.css` 2151 行单文件、124 个 CSS 变量 | `styles.css` | 按 tokens/layout/chat/settings/overlays 拆分（勿改 CSS-in-JS，与既有令牌约定冲突） |
| L7 | 硬编码中文文案约 2700 字 | `App.tsx` 独占 1536 | **不建议现在抽 i18n**（中文单市场、无 locale 入口，收益远小于成本）；仅抽重复错误文案与耦合魔数的文案 |
| L8 | `listAgents()` N+1 查询 | `database.ts:398-401,415` | 一次查询 JOIN 或批量预取 |
| L9 | `addMessage` 序号分配无事务 | `database.ts:682-695` | 显式事务；并发发言需映射为用户可读错误 |
| L10 | CI 缺 audit / coverage / Dependabot 门禁 | `.github/workflows/ci.yml` | 补 `pnpm audit --audit-level=high`、coverage 阈值、Dependabot |
| L11 | `.gitignore` 遗漏 | 根目录 | 补 `shots/`、`.workbuddy/`、`electron.vite.config.*.mjs` |
| L12 | `removeAgent` 不删消息无注释 | `database.ts:486-497` | 明确意图并加注释 |
| L13 | CSP `connect-src` 放行任意 localhost 端口 | `src/renderer/index.html:7` | 生产环境收紧 |
| L14 | 依赖大版本落后 15 项 | `package.json` | 常规跟进；`zod` 3→4 为破坏性跳跃需单独规划 |
| L15 | 文档缺 CONTRIBUTING / ADR / 契约说明 | `docs/`、根目录 | 补 `CONTRIBUTING.md`；根目录三份 V1.0 文档标注实现状态 |

---

## 评审结论

### 整体质量评价

**这是一份远超同类项目平均水平的代码库，工程纪律与安全意识突出，但存在局部过度设计与几处真实的安全缺口。**

**三个维度打分（主观评估）：**

| 维度 | 评价 | 依据 |
|---|---|---|
| **安全性** | **A-** | Electron 三项防护全开、CSP 无 `unsafe-eval`、零 `dangerouslySetInnerHTML`、零真实密钥泄露、`safeStorage` 加密、分级日志白名单脱敏、CI 对打包产物做真实安全边界测试。扣分点是 IPC 入参校验覆盖仅 3/30 |
| **代码质量** | **B+** | `tsc --noEmit` 零错误、`any` 零处、ts-ignore 零处、TODO 零处、空 catch 零处、测试是真正的行为测试而非快照。但存在 God Object、8 组重复、错误分类体系名存实亡、死代码 |
| **工程化** | **B** | CI 配置优秀（双平台 + 打包产物冒烟 + 供应链 allowlist + 自动生成版本矩阵）。但**零 lint/format/commit 门禁**、无覆盖率阈值、测试超时未配置导致全量测试假失败 |

**核心判断：这是一个"安全意识先行、但缺乏自动化质量门禁"的团队。** 代码里的安全设计（脱敏白名单、原子替换、乐观并发、路径校验）明显是经过思考的，说明团队有工程素养；但 `.codex/skills/` 里那套完整的 Ponytail 审核流程只存在于文档里，没有 linter、没有 commit hook、没有 CI 门禁来强制执行——**规范靠人遵守，就必然会被绕过**。

值得肯定的是，团队**主动纠正了我两次误判**：审计工具报告的"生产依赖高危漏洞"经 lock 核验实为过时数据（已修复版本）；"15 个测试文件失败"实为超时阈值问题而非逻辑缺陷。这种如实反馈让评审结论更可靠。

### 最值得优先改进的三件事

#### 1. 补齐 IPC 入参校验层（安全 + 一致性）

**为什么第一：** 这是唯一一个**真实的安全缺口**——`spaces:updateContext` 可从沙箱 renderer 无限制写入数据库，直接违反项目自己的 `codx.md` 规范。而 30 个 handler 只有 3 处校验，意味着这不是漏了一处，而是**缺少统一入口**，每加一个 channel 都会重犯。

**怎么做：** 在 `src/shared/` 建立 zod schema 层（项目已依赖 zod，但只用在 1 个文件），30 个 handler 统一走 schema 解析。顺带把 IPC channel 名抽到 `src/shared/channels.ts` —— 现在 34 个通道名字面量在 preload 与 main 各写一遍，共 68 处无编译期保障。这项改动同时收敛了安全缺口与重复代码。

#### 2. 建立 lint + format + commit 自动化门禁

**为什么第二：** 团队已经写好了 `codx.md`（含 Ponytail 预审、职责边界、最小改动等完整规范）和 `.codex/skills/` 34 个 skill 目录 —— **规范质量很高，但完全靠人执行**。报告中的重复代码、God Object、死代码、格式漂移，本质上都是"人工审查会漏、linter 不会漏"的问题。

**怎么做：** ESLint flat config + Prettier 接入 husky pre-commit 与 CI。这一步的投入产出比最高，且能顺带解决 8 组重复中的大部分。**建议先只开 `no-unused-vars`、`no-explicit-any`、`no-non-null-assertion` 三条高价值规则**，避免一次性引入过多噪音。

#### 3. 修复测试超时配置，让测试真正可用

**为什么第三：** 当前 `pnpm test` 需要 4 分钟以上并报出"15 文件失败"，这对日常开发的伤害被严重低估——开发者会开始忽略测试红灯，测试体系就失效了。而根因只是一个 6 行配置文件里缺失的 `testTimeout`。

**怎么做：** `vitest.config.ts` 显式设置 `testTimeout: 20000`；补覆盖率阈值（当前**完全没有**覆盖率配置）；把 CI 中已有的 `scripts/electron-e2e-smoke.mjs` 纳入统一 `test:e2e` 入口。做完这步之后，测试才真正具备"当信号用"的能力。

---

### 附：实测验证记录

| 检查项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit` | ✅ 通过，零错误 |
| 测试（单文件） | `npx vitest run tests/database-agent.test.ts` | ✅ 22/22 全绿 |
| 测试（全量） | `npx vitest run` | ⚠️ 15 文件失败 —— 实为 `Test timed out in 5000ms`，非断言失败 |
| 类型逃逸统计 | grep | ✅ `any` 0 / ts-ignore 0 / TODO 0 / 空 catch 0 / `as unknown as` 6 |
| IPC handler 数 | `grep -c "ipcMain.handle"` | 30 个，仅 3 处 `typeof` 校验 |
| Electron 安全配置 | grep | ✅ sandbox + contextIsolation + nodeIntegration:false |
| 敏感信息扫描 | grep 私钥/Bearer/sk- 模式 | ✅ 无真实泄露（仅占位符与测试夹具） |
| 依赖冗余 | 遍历 60 个依赖 grep 引用 | ✅ 零冗余 |
| 漏洞核验 | 逐一比对 pnpm-lock.yaml | ✅ 生产依赖已处安全版本（修正审计工具误报） |
| 版本控制卫生 | `git ls-files` | ✅ release/out/logs 追踪数均为 0，总计 250 文件 |
| 工程化配置 | ls 探测 | ❌ eslint/prettier/biome/commitlint/husky 全缺失 |
