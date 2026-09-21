# MindMesh Codex 工作规范

本文件是 MindMesh 的项目级行动规范。适用于源代码、测试、数据结构、依赖、脚本和构建配置的新增、修改、重构、修复与删除。

## 强制执行顺序

任何代码改动开始前，必须按以下顺序执行；完成前不得写入代码。

1. 阅读任务和相关代码，追踪本次改动涉及的真实调用路径与现有实现。
2. 完整读取 `.codex/skills/ponytail/SKILL.md`，默认使用 `full` 强度进行 Ponytail 审核。
3. 在 commentary 中先输出一条可核验的预审结论：

   ```text
   Ponytail 预审：必要性=<为什么要改>；复用=<已有实现>；最小方案=<最少文件/最短改动>；验证=<最小可运行检查>
   ```

4. 从 `.codex/skills/` 选择与任务匹配的 skill，完整读取其 `SKILL.md` 及其中明确要求的直接引用文件，并在 commentary 中说明使用哪个 skill 及原因。
5. 只有前四步完成后才可修改代码。优先级依次为：复用现有实现、标准库、平台原生能力、已安装依赖、最小新代码。
6. 修改后运行与风险相称的最小验证。包含分支、循环、解析、安全或数据路径的非平凡逻辑，至少留下一个可重复运行的检查。

## Ponytail 审核标准

- 先判断需求是否确实需要代码；推测性能力暂不实现。
- 修改前搜索同类实现和全部相关调用方，修复根因，不在多个表层位置重复打补丁。
- 不为单一实现引入接口、工厂或预留抽象。
- 不为少量代码增加新依赖；同等可行时选择文件更少、维护面更小的方案。
- 输入边界验证、数据安全、错误处理和可访问性不得被简化掉。
- 已有用户改动必须保留；仅修改当前任务需要的文件。

## Skill 路由

Ponytail 是每次代码改动的基础 skill。再按任务增加最小必要 skill：

- 实现功能：`.codex/skills/implement/SKILL.md`
- 原型与 UI：`.codex/skills/prototype/SKILL.md`
- 修复故障：`.codex/skills/diagnosing-bugs/SKILL.md`
- 测试驱动：`.codex/skills/tdd/SKILL.md`
- 代码审查：`.codex/skills/code-review/SKILL.md`
- 架构调整：`.codex/skills/improve-codebase-architecture/SKILL.md`
- 编写代理规范：`.codex/skills/writing-for-agents/SKILL.md`

未命中额外 skill 时，继续以 Ponytail 作为行动指南，不因此阻塞任务。

## 完成标准

一次代码任务只有同时满足以下条件才算完成：

- 已在改动前给出 Ponytail 预审。
- 已读取并遵循适用 skill。
- 改动是满足需求的最小完整方案。
- 相关类型检查、测试、构建或针对性复现已经通过；无法运行的检查已明确说明原因。
- 结果只保存在本地；除非用户明确要求，不上传远程仓库。
