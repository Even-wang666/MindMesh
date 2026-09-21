# MindMesh

MindMesh 是一个本地优先的多智能体创建与协作桌面平台。当前版本实现了 Electron + React 桌面壳、Agent 创建、私聊、Space、`@Agent` 顺序协作、本地 SQLite 持久化，以及 DeepSeek Harness SDK Adapter。

## 本地环境

- Node.js 24+
- pnpm 11.7.0（通过 Corepack 固定）
- Conda 环境：项目根目录 `.conda`，Python 3.11
- DeepSeek Harness：`0.1.6-alpha.2`
- Harness 参考源码：`.references/deepseek-harness`，提交 `ddefc45fbc7f8e46dd73185e68295696d1297887`

## 启动

```powershell
corepack pnpm@11.7.0 install
corepack pnpm@11.7.0 dev
```

首次启动时，进入「设置 → 模型服务」，填写 DeepSeek API Key 即可启用真实模型回复。密钥由操作系统加密后保存在当前设备，不会写入项目、SQLite 或日志。

未配置 API Key 时，应用使用本地演示响应，所有页面和协作流程仍然可用。开发环境也可以在当前终端设置：

```powershell
$env:DEEPSEEK_API_KEY = "你的密钥"
corepack pnpm@11.7.0 dev
```

## 校验

```powershell
corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 test
corepack pnpm@11.7.0 build
```

Harness 子进程握手 PoC：

```powershell
corepack pnpm@11.7.0 poc:harness
```

Windows unpacked 版本位于 `release/win-unpacked/MindMesh.exe`。重新生成：

```powershell
corepack pnpm@11.7.0 package:dir
```

产品数据保存在 Electron `userData/mindmesh-data`，不保存在源码目录。`.conda`、`.references`、依赖、构建产物和环境变量文件均已加入 `.gitignore`。
