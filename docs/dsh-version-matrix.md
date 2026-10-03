# DSH 兼容版本矩阵

生成命令：`corepack pnpm@11.7.0 check:dsh-deps --write`。数据来自实际安装发行包的 package.json（包含发布版本及 peer 要求），不使用 latest 标签。

Direct: 34；传递运行实例: 533；required dependency/peer 校验失败: 0。

校验所有 direct exact version，并分别遍历实际解析出的传递 dependencies/peerDependencies；本机缺失的 optional dependency/peer 单独记录。Windows 打包闭包另由 `check:package-deps` 验证，禁止回退到工作区 node_modules，并要求本机已安装的 optional 运行依赖（含平台 native payload）随包分发。

| 包 | Requested | Installed | Published peerDependencies |
| --- | --- | --- | --- |
| @deepseek-ai/cordis | 4.0.4 | 4.0.4 | @deepseek-ai/cordis-plugin-include: ~1.0.9<br>@deepseek-ai/cordis-plugin-loader: ~1.0.5 |
| @deepseek-ai/cordis-plugin-group | 1.0.4 | 1.0.4 | @deepseek-ai/cordis: ~4.0.4<br>@deepseek-ai/cordis-plugin-loader: ~1.0.5 |
| @deepseek-ai/dsh | 0.2.0-rc.2 | 0.2.0-rc.2 | — |
| @deepseek-ai/dsh-anonymous-user-id | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/dsh-home-paths: 0.2.0-rc.2<br>@deepseek-ai/cordis: ~4.0.4<br>@deepseek-ai/dsh-brand: 0.2.0-rc.2 |
| @deepseek-ai/dsh-attachment | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/cordis: ~4.0.4<br>@deepseek-ai/dsh-brand: 0.2.0-rc.2 |
| @deepseek-ai/dsh-authorization | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/dsh-credentials: 0.2.0-rc.2<br>@deepseek-ai/dsh-llm: 0.2.0-rc.2<br>@deepseek-ai/cordis: ~4.0.4<br>@deepseek-ai/dsh-invariants: 0.2.0-rc.2 |
| @deepseek-ai/dsh-bash-local | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/dsh-subprocess: 0.2.0-rc.2<br>@deepseek-ai/dsh-shell: 0.2.0-rc.2<br>@deepseek-ai/dsh-timeout: 0.2.0-rc.2<br>@deepseek-ai/cordis: ~4.0.4 |
| @deepseek-ai/dsh-client-store | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/cordis: ~4.0.4 |
| @deepseek-ai/dsh-client-ui-primitives | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/cordis: ~4.0.4 |
| @deepseek-ai/dsh-client-ui-slots | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/cordis: ~4.0.4 |
| @deepseek-ai/dsh-compaction | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/dsh-brand: 0.2.0-rc.2<br>@deepseek-ai/dsh-commands: 0.2.0-rc.2<br>@deepseek-ai/dsh-invariants: 0.2.0-rc.2<br>@deepseek-ai/dsh-llm: 0.2.0-rc.2<br>@deepseek-ai/dsh-session: 0.2.0-rc.2<br>@deepseek-ai/cordis: ~4.0.4 |
| @deepseek-ai/dsh-deepseek-account | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/cordis: ~4.0.4<br>@deepseek-ai/dsh-brand: 0.2.0-rc.2<br>@deepseek-ai/dsh-agent: 0.2.0-rc.2<br>@deepseek-ai/dsh-llm: 0.2.0-rc.2 |
| @deepseek-ai/dsh-fs | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/dsh-invariants: 0.2.0-rc.2<br>@deepseek-ai/dsh-llm: 0.2.0-rc.2<br>@deepseek-ai/dsh-sandbox: 0.2.0-rc.2<br>@deepseek-ai/cordis: ~4.0.4<br>@deepseek-ai/dsh-brand: 0.2.0-rc.2 |
| @deepseek-ai/dsh-hook-protocol | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/dsh-shell: 0.2.0-rc.2<br>@deepseek-ai/dsh-invariants: 0.2.0-rc.2<br>@deepseek-ai/dsh-session: 0.2.0-rc.2<br>@deepseek-ai/cordis: ~4.0.4 |
| @deepseek-ai/dsh-jobs | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/dsh-brand: 0.2.0-rc.2<br>@deepseek-ai/dsh-agent: 0.2.0-rc.2<br>@deepseek-ai/dsh-invariants: 0.2.0-rc.2<br>@deepseek-ai/dsh-session: 0.2.0-rc.2<br>@deepseek-ai/dsh-workspace: 0.2.0-rc.2<br>@deepseek-ai/cordis: ~4.0.4 |
| @deepseek-ai/dsh-llm | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/cordis: ~4.0.4 |
| @deepseek-ai/dsh-llm-deepseek | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/cordis: ~4.0.4<br>@deepseek-ai/dsh-anonymous-user-id: 0.2.0-rc.2<br>@deepseek-ai/dsh-deepseek-llm-api-extensions: 0.2.0-rc.2<br>@deepseek-ai/dsh-attachment: 0.2.0-rc.2<br>@deepseek-ai/dsh-atomic-write: 0.2.0-rc.2<br>@deepseek-ai/dsh-fs: 0.2.0-rc.2<br>@deepseek-ai/dsh-home-paths: 0.2.0-rc.2<br>@deepseek-ai/dsh-launch-environment: 0.2.0-rc.2<br>@deepseek-ai/dsh-timeout: 0.2.0-rc.2<br>@deepseek-ai/cordis-plugin-loader: ~1.0.5<br>@deepseek-ai/dsh-llm: 0.2.0-rc.2 |
| @deepseek-ai/dsh-output-retention | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/cordis: ~4.0.4 |
| @deepseek-ai/dsh-ptc-runtime | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/cordis: ~4.0.4<br>@deepseek-ai/dsh-sandbox: 0.2.0-rc.2 |
| @deepseek-ai/dsh-sandbox | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/cordis: ~4.0.4<br>@deepseek-ai/dsh-llm: 0.2.0-rc.2<br>@deepseek-ai/dsh-session: 0.2.0-rc.2 |
| @deepseek-ai/dsh-sdk-client | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/dsh-llm: 0.2.0-rc.2<br>@deepseek-ai/dsh-sdk-protocol: 0.2.0-rc.2<br>@deepseek-ai/dsh-session: 0.2.0-rc.2<br>@deepseek-ai/cordis: ~4.0.4 |
| @deepseek-ai/dsh-sdk-protocol | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/dsh-llm: 0.2.0-rc.2<br>@deepseek-ai/dsh-session: 0.2.0-rc.2<br>@deepseek-ai/dsh-subagent: 0.2.0-rc.2<br>@deepseek-ai/cordis: ~4.0.4 |
| @deepseek-ai/dsh-session | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/cordis: ~4.0.4<br>@deepseek-ai/dsh-scope: 0.2.0-rc.2 |
| @deepseek-ai/dsh-session-persistence | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/cordis: ~4.0.4<br>@deepseek-ai/dsh-brand: 0.2.0-rc.2<br>@deepseek-ai/dsh-session: 0.2.0-rc.2<br>@deepseek-ai/dsh-timeout: 0.2.0-rc.2 |
| @deepseek-ai/dsh-session-query | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/dsh-brand: 0.2.0-rc.2<br>@deepseek-ai/dsh-session: 0.2.0-rc.2<br>@deepseek-ai/dsh-llm: 0.2.0-rc.2<br>@deepseek-ai/dsh-session-title: 0.2.0-rc.2<br>@deepseek-ai/dsh-tool-todo: 0.2.0-rc.2<br>@deepseek-ai/dsh-session-persistence: 0.2.0-rc.2<br>@deepseek-ai/dsh-session-projection: 0.2.0-rc.2<br>@deepseek-ai/dsh-session-projection-cache: 0.2.0-rc.2<br>@deepseek-ai/cordis: ~4.0.4 |
| @deepseek-ai/dsh-session-telemetry | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/dsh-agent: 0.2.0-rc.2<br>@deepseek-ai/dsh-session: 0.2.0-rc.2<br>@deepseek-ai/cordis: ~4.0.4 |
| @deepseek-ai/dsh-session-title-llm | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/cordis: ~4.0.4<br>@deepseek-ai/dsh-llm: 0.2.0-rc.2<br>@deepseek-ai/dsh-session: 0.2.0-rc.2<br>@deepseek-ai/dsh-session-title: 0.2.0-rc.2<br>@deepseek-ai/dsh-timeout: 0.2.0-rc.2 |
| @deepseek-ai/dsh-settings | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/cordis: ~4.0.4<br>@deepseek-ai/dsh-brand: 0.2.0-rc.2<br>@deepseek-ai/dsh-session: 0.2.0-rc.2<br>@deepseek-ai/schemastery: ~3.18.4<br>@deepseek-ai/dsh-invariants: 0.2.0-rc.2 |
| @deepseek-ai/dsh-shell | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/dsh-sandbox: 0.2.0-rc.2<br>@deepseek-ai/cordis: ~4.0.4<br>@deepseek-ai/dsh-subprocess: 0.2.0-rc.2 |
| @deepseek-ai/dsh-spill | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/dsh-llm: 0.2.0-rc.2<br>@deepseek-ai/cordis: ~4.0.4<br>@deepseek-ai/dsh-session: 0.2.0-rc.2<br>@deepseek-ai/dsh-brand: 0.2.0-rc.2 |
| @deepseek-ai/dsh-subagent-in-process-driver | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/dsh-agent: 0.2.0-rc.2<br>@deepseek-ai/dsh-llm: 0.2.0-rc.2<br>@deepseek-ai/dsh-session: 0.2.0-rc.2<br>@deepseek-ai/dsh-subagent: 0.2.0-rc.2<br>@deepseek-ai/dsh-system-prompt: 0.2.0-rc.2<br>@deepseek-ai/cordis: ~4.0.4<br>@deepseek-ai/dsh-tools: 0.2.0-rc.2 |
| @deepseek-ai/dsh-util-time | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/cordis: ~4.0.4 |
| @deepseek-ai/dsh-util-workspace-path | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/cordis: ~4.0.4 |
| @deepseek-ai/dsh-workflow | 0.2.0-rc.2 | 0.2.0-rc.2 | @deepseek-ai/dsh-agent: 0.2.0-rc.2<br>@deepseek-ai/dsh-brand: 0.2.0-rc.2<br>@deepseek-ai/dsh-invariants: 0.2.0-rc.2<br>@deepseek-ai/dsh-llm: 0.2.0-rc.2<br>@deepseek-ai/dsh-session: 0.2.0-rc.2<br>@deepseek-ai/cordis: ~4.0.4 |

## 实际解析的 DSH/Cordis 运行闭包

- `@deepseek-ai/cordis-plugin-group@1.0.4`
- `@deepseek-ai/cordis-plugin-include@1.0.9`
- `@deepseek-ai/cordis-plugin-loader@1.0.5`
- `@deepseek-ai/cordis-plugin-timer@1.1.6`
- `@deepseek-ai/cordis@4.0.4`
- `@deepseek-ai/cosmokit@1.8.5`
- `@deepseek-ai/dsh-acp-app@0.2.0-rc.2`
- `@deepseek-ai/dsh-acp@0.2.0-rc.2`
- `@deepseek-ai/dsh-agent-default-model@0.2.0-rc.2`
- `@deepseek-ai/dsh-agent-instructions@0.2.0-rc.2`
- `@deepseek-ai/dsh-agent-loop@0.2.0-rc.2`
- `@deepseek-ai/dsh-agent-preset-registry@0.2.0-rc.2`
- `@deepseek-ai/dsh-agent-preset@0.2.0-rc.2`
- `@deepseek-ai/dsh-agent-tool-presentation@0.2.0-rc.2`
- `@deepseek-ai/dsh-agent@0.2.0-rc.2`
- `@deepseek-ai/dsh-anonymous-user-id@0.2.0-rc.2`
- `@deepseek-ai/dsh-api-account-controller@0.2.0-rc.2`
- `@deepseek-ai/dsh-api-gateway@0.2.0-rc.2`
- `@deepseek-ai/dsh-api-job-controller@0.2.0-rc.2`
- `@deepseek-ai/dsh-api-remotes@0.2.0-rc.2`
- `@deepseek-ai/dsh-api-session-controller@0.2.0-rc.2`
- `@deepseek-ai/dsh-api-settings-controller@0.2.0-rc.2`
- `@deepseek-ai/dsh-api-terminal-controller@0.2.0-rc.2`
- `@deepseek-ai/dsh-api-workspace-controller@0.2.0-rc.2`
- `@deepseek-ai/dsh-api-workspace-files@0.2.0-rc.2`
- `@deepseek-ai/dsh-app-boot@0.2.0-rc.2`
- `@deepseek-ai/dsh-atomic-write@0.2.0-rc.2`
- `@deepseek-ai/dsh-attachment-local@0.2.0-rc.2`
- `@deepseek-ai/dsh-attachment@0.2.0-rc.2`
- `@deepseek-ai/dsh-authorization@0.2.0-rc.2`
- `@deepseek-ai/dsh-base@0.2.0-rc.2`
- `@deepseek-ai/dsh-bash-local@0.2.0-rc.2`
- `@deepseek-ai/dsh-bash-sandbox@0.2.0-rc.2`
- `@deepseek-ai/dsh-brand@0.2.0-rc.2`
- `@deepseek-ai/dsh-chunked-list@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-connection@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-file-upload@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-hmr@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-locale@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-modules@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-product-analytics@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-resources@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-shortcuts@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-store@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-agent-preset@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-approval@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-attachment@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-brand-official@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-chat@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-commands@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-conversation@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-cordis@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-deliverables@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-directory-picker-browse@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-directory-picker-native@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-goal@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-input-trigger@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-jobs@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-layout@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-message-feedback@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-model-selection@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-open-in-app@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-permission-presets@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-plan@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-plugin-manager@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-reference@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-renderer@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-schedule@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-session@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-settings-account@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-settings-agent-loop@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-settings-general@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-settings-models@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-settings-plugin-inventory@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-settings-plugins@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-settings-session-log@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-settings-shell@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-settings-subagent@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-settings-web-search@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-settings@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-shortcuts@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-sidebar-browser@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-sidebar-documentpreview@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-sidebar-files@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-sidebar-right@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-sidebar-terminal@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-sidebar@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-skill@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-slots@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-subagent@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-theme@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-tool@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-trajectory@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-user-questions@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-workflow-run@0.2.0-rc.2`
- `@deepseek-ai/dsh-client-ui-workspace@0.2.0-rc.2`
- `@deepseek-ai/dsh-cmdline@0.2.0-rc.2`
- `@deepseek-ai/dsh-command-compact@0.2.0-rc.2`
- `@deepseek-ai/dsh-command-feedback@0.2.0-rc.2`
- `@deepseek-ai/dsh-command-goal@0.2.0-rc.2`
- `@deepseek-ai/dsh-commands@0.2.0-rc.2`
- `@deepseek-ai/dsh-compaction-basic@0.2.0-rc.2`
- `@deepseek-ai/dsh-compaction-image-offload@0.2.0-rc.2`
- `@deepseek-ai/dsh-compaction-tool-result-pruner@0.2.0-rc.2`
- `@deepseek-ai/dsh-compaction@0.2.0-rc.2`
- `@deepseek-ai/dsh-config-editor@0.2.0-rc.2`
- `@deepseek-ai/dsh-cordis-client-runner@0.2.0-rc.2`
- `@deepseek-ai/dsh-cordis-host-runner@0.2.0-rc.2`
- `@deepseek-ai/dsh-credentials-local@0.2.0-rc.2`
- `@deepseek-ai/dsh-credentials@0.2.0-rc.2`
- `@deepseek-ai/dsh-deepseek-account-platform@0.2.0-rc.2`
- `@deepseek-ai/dsh-deepseek-account@0.2.0-rc.2`
- `@deepseek-ai/dsh-deepseek-llm-api-extensions@0.2.0-rc.2`
- `@deepseek-ai/dsh-deque@0.2.0-rc.2`
- `@deepseek-ai/dsh-experimental-agent-team-profile@0.2.0-rc.2`
- `@deepseek-ai/dsh-experimental-agent-team@0.2.0-rc.2`
- `@deepseek-ai/dsh-experimental-api-speech-to-text@0.2.0-rc.2`
- `@deepseek-ai/dsh-experimental-auto-review@0.2.0-rc.2`
- `@deepseek-ai/dsh-experimental-client-ui-agent-team@0.2.0-rc.2`
- `@deepseek-ai/dsh-experimental-client-ui-voice-input@0.2.0-rc.2`
- `@deepseek-ai/dsh-experimental-schedule-bundle@0.2.0-rc.2`
- `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice@0.2.0-rc.2`
- `@deepseek-ai/dsh-experimental-speech-to-text@0.2.0-rc.2`
- `@deepseek-ai/dsh-experimental-tool-agent-team@0.2.0-rc.2`
- `@deepseek-ai/dsh-experimental-voice-input-bundle@0.2.0-rc.2`
- `@deepseek-ai/dsh-file-reference-local@0.2.0-rc.2`
- `@deepseek-ai/dsh-file-reference@0.2.0-rc.2`
- `@deepseek-ai/dsh-fs-local@0.2.0-rc.2`
- `@deepseek-ai/dsh-fs-observation-policy@0.2.0-rc.2`
- `@deepseek-ai/dsh-fs-sandbox@0.2.0-rc.2`
- `@deepseek-ai/dsh-fs@0.2.0-rc.2`
- `@deepseek-ai/dsh-goal-round-driver@0.2.0-rc.2`
- `@deepseek-ai/dsh-goal@0.2.0-rc.2`
- `@deepseek-ai/dsh-headless@0.2.0-rc.2`
- `@deepseek-ai/dsh-hmr@0.2.0-rc.2`
- `@deepseek-ai/dsh-home-paths@0.2.0-rc.2`
- `@deepseek-ai/dsh-hook-protocol@0.2.0-rc.2`
- `@deepseek-ai/dsh-hooks-claude-code@0.2.0-rc.2`
- `@deepseek-ai/dsh-hooks-codex@0.2.0-rc.2`
- `@deepseek-ai/dsh-host-directory-picker-auto@0.2.0-rc.2`
- `@deepseek-ai/dsh-host-directory-picker-browse@0.2.0-rc.2`
- `@deepseek-ai/dsh-host-directory-picker-native@0.2.0-rc.2`
- `@deepseek-ai/dsh-host-directory-picker@0.2.0-rc.2`
- `@deepseek-ai/dsh-host-frontend-static@0.2.0-rc.2`
- `@deepseek-ai/dsh-host-open-in-app@0.2.0-rc.2`
- `@deepseek-ai/dsh-host-plugin-inventory@0.2.0-rc.2`
- `@deepseek-ai/dsh-host-product-telemetry-otel@0.2.0-rc.2`
- `@deepseek-ai/dsh-host-webserver@0.2.0-rc.2`
- `@deepseek-ai/dsh-http-proxy@0.2.0-rc.2`
- `@deepseek-ai/dsh-invariants@0.2.0-rc.2`
- `@deepseek-ai/dsh-jobs-local@0.2.0-rc.2`
- `@deepseek-ai/dsh-jobs@0.2.0-rc.2`
- `@deepseek-ai/dsh-launch-environment@0.2.0-rc.2`
- `@deepseek-ai/dsh-lazy-require@0.2.0-rc.2`
- `@deepseek-ai/dsh-llm-deepseek-account@0.2.0-rc.2`
- `@deepseek-ai/dsh-llm-deepseek-api-key@0.2.0-rc.2`
- `@deepseek-ai/dsh-llm-deepseek@0.2.0-rc.2`
- `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2`
- `@deepseek-ai/dsh-llm-retry@0.2.0-rc.2`
- `@deepseek-ai/dsh-llm@0.2.0-rc.2`
- `@deepseek-ai/dsh-mcp-client@0.2.0-rc.2`
- `@deepseek-ai/dsh-mcp-resources@0.2.0-rc.2`
- `@deepseek-ai/dsh-message-feedback@0.2.0-rc.2`
- `@deepseek-ai/dsh-native-command@0.2.0-rc.2`
- `@deepseek-ai/dsh-office-to-pdf@0.2.0-rc.2`
- `@deepseek-ai/dsh-otel@0.2.0-rc.2`
- `@deepseek-ai/dsh-output-retention@0.2.0-rc.2`
- `@deepseek-ai/dsh-package-manifest@0.2.0-rc.2`
- `@deepseek-ai/dsh-permission-presets@0.2.0-rc.2`
- `@deepseek-ai/dsh-persona@0.2.0-rc.2`
- `@deepseek-ai/dsh-plan-mode@0.2.0-rc.2`
- `@deepseek-ai/dsh-plugin-manager@0.2.0-rc.2`
- `@deepseek-ai/dsh-plugin-package-inventory-deepseek@0.2.0-rc.2`
- `@deepseek-ai/dsh-ptc-runtime-node@0.2.0-rc.2`
- `@deepseek-ai/dsh-ptc-runtime@0.2.0-rc.2`
- `@deepseek-ai/dsh-pwsh-local@0.2.0-rc.2`
- `@deepseek-ai/dsh-pwsh-sandbox@0.2.0-rc.2`
- `@deepseek-ai/dsh-repeat-tool-reminder@0.2.0-rc.2`
- `@deepseek-ai/dsh-sandbox-local@0.2.0-rc.2`
- `@deepseek-ai/dsh-sandbox-policy@0.2.0-rc.2`
- `@deepseek-ai/dsh-sandbox-windows-acl@0.2.0-rc.2`
- `@deepseek-ai/dsh-sandbox@0.2.0-rc.2`
- `@deepseek-ai/dsh-schedule@0.2.0-rc.2`
- `@deepseek-ai/dsh-scope@0.2.0-rc.2`
- `@deepseek-ai/dsh-sdk-app@0.2.0-rc.2`
- `@deepseek-ai/dsh-sdk-client@0.2.0-rc.2`
- `@deepseek-ai/dsh-sdk-jsonrpc-server@0.2.0-rc.2`
- `@deepseek-ai/dsh-sdk-minimal@0.2.0-rc.2`
- `@deepseek-ai/dsh-sdk-protocol@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-checkpoint-policy@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-format-catalog@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-format-v0-to-v1@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-format-v1-to-v2@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-format-v2-to-v3@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-format-v3-to-v4@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-format@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-log-deepseek@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-log-export@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-persistence-jsonl@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-persistence@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-projection-cache@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-projection@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-query-sqlite@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-query@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-reference@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-stats@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-telemetry-otel@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-telemetry@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-title-first-prompt-llm@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-title-llm@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-title@0.2.0-rc.2`
- `@deepseek-ai/dsh-session-turn-outline@0.2.0-rc.2`
- `@deepseek-ai/dsh-session@0.2.0-rc.2`
- `@deepseek-ai/dsh-settings@0.2.0-rc.2`
- `@deepseek-ai/dsh-shell-env@0.2.0-rc.2`
- `@deepseek-ai/dsh-shell@0.2.0-rc.2`
- `@deepseek-ai/dsh-skill-badge@0.2.0-rc.2`
- `@deepseek-ai/dsh-skill-filesystem@0.2.0-rc.2`
- `@deepseek-ai/dsh-skill-office@0.2.0-rc.2`
- `@deepseek-ai/dsh-skill@0.2.0-rc.2`
- `@deepseek-ai/dsh-spill-local@0.2.0-rc.2`
- `@deepseek-ai/dsh-spill-policy@0.2.0-rc.2`
- `@deepseek-ai/dsh-spill@0.2.0-rc.2`
- `@deepseek-ai/dsh-storage-domain@0.2.0-rc.2`
- `@deepseek-ai/dsh-storage-json@0.2.0-rc.2`
- `@deepseek-ai/dsh-storage@0.2.0-rc.2`
- `@deepseek-ai/dsh-subagent-fork-in-process@0.2.0-rc.2`
- `@deepseek-ai/dsh-subagent-in-process-driver@0.2.0-rc.2`
- `@deepseek-ai/dsh-subagent-spawn-in-process@0.2.0-rc.2`
- `@deepseek-ai/dsh-subagent@0.2.0-rc.2`
- `@deepseek-ai/dsh-subprocess-local@0.2.0-rc.2`
- `@deepseek-ai/dsh-subprocess@0.2.0-rc.2`
- `@deepseek-ai/dsh-system-prompt@0.2.0-rc.2`
- `@deepseek-ai/dsh-terminal-bash@0.2.0-rc.2`
- `@deepseek-ai/dsh-terminal@0.2.0-rc.2`
- `@deepseek-ai/dsh-time-context@0.2.0-rc.2`
- `@deepseek-ai/dsh-timeout@0.2.0-rc.2`
- `@deepseek-ai/dsh-tmux-context@0.2.0-rc.2`
- `@deepseek-ai/dsh-token-meter@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-ask-user@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-bash-persistent@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-bash@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-call-timeout-policy@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-cordis@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-fs-search@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-fs@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-goal@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-jobs@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-present@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-pwsh-persistent@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-pwsh@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-ralph@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-skill@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-str-replace-editor@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-subagent-control@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-subagent@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-todo@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-web@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-workflow@0.2.0-rc.2`
- `@deepseek-ai/dsh-tool-workspace-dependencies@0.2.0-rc.2`
- `@deepseek-ai/dsh-tools@0.2.0-rc.2`
- `@deepseek-ai/dsh-typert-loader@0.2.0-rc.2`
- `@deepseek-ai/dsh-typert-protocol@0.2.0-rc.2`
- `@deepseek-ai/dsh-typert-registry@0.2.0-rc.2`
- `@deepseek-ai/dsh-user-approval@0.2.0-rc.2`
- `@deepseek-ai/dsh-user-questions@0.2.0-rc.2`
- `@deepseek-ai/dsh-util-code-language@0.2.0-rc.2`
- `@deepseek-ai/dsh-util-crypto@0.2.0-rc.2`
- `@deepseek-ai/dsh-util-time@0.2.0-rc.2`
- `@deepseek-ai/dsh-util-values@0.2.0-rc.2`
- `@deepseek-ai/dsh-util-workspace-path@0.2.0-rc.2`
- `@deepseek-ai/dsh-web-app@0.2.0-rc.2`
- `@deepseek-ai/dsh-web-fetch-http@0.2.0-rc.2`
- `@deepseek-ai/dsh-web-frontend@0.2.0-rc.2`
- `@deepseek-ai/dsh-web-search-deepseek@0.2.0-rc.2`
- `@deepseek-ai/dsh-web@0.2.0-rc.2`
- `@deepseek-ai/dsh-webhook-github@0.2.0-rc.2`
- `@deepseek-ai/dsh-webhook@0.2.0-rc.2`
- `@deepseek-ai/dsh-win32-process@0.2.0-rc.2`
- `@deepseek-ai/dsh-workflow-ptc@0.2.0-rc.2`
- `@deepseek-ai/dsh-workflow@0.2.0-rc.2`
- `@deepseek-ai/dsh-workspace-changes@0.2.0-rc.2`
- `@deepseek-ai/dsh-workspace@0.2.0-rc.2`
- `@deepseek-ai/dsh@0.2.0-rc.2`
- `@deepseek-ai/libreoffice-kit-win32-x64@0.1.5`
- `@deepseek-ai/libreoffice-kit@0.1.5`
- `@deepseek-ai/node-addon-system@0.1.2`
- `@deepseek-ai/schemastery@3.18.4`

## 本机缺失的可选依赖

- `node-addon-require-builtin@0.1.6 -> node-addon-require-builtin-darwin-arm64@0.1.6`
- `node-addon-require-builtin@0.1.6 -> node-addon-require-builtin-darwin-x64@0.1.6`
- `node-addon-require-builtin@0.1.6 -> node-addon-require-builtin-linux-arm64-gnu@0.1.6`
- `node-addon-require-builtin@0.1.6 -> node-addon-require-builtin-linux-x64-gnu@0.1.6`
- `node-addon-require-builtin@0.1.6 -> node-addon-require-builtin-win32-arm64-msvc@0.1.6`
- `node-addon-require-builtin@0.1.6 -> node-addon-require-builtin-win32-ia32-msvc@0.1.6`
- `ws@8.21.3 -> bufferutil@^4.0.1`
- `ws@8.21.3 -> utf-8-validate@>=5.0.2`
- `sherpa-onnx-node@1.13.8 -> sherpa-onnx-darwin-arm64@^1.13.8`
- `sherpa-onnx-node@1.13.8 -> sherpa-onnx-darwin-x64@^1.13.8`
- `sherpa-onnx-node@1.13.8 -> sherpa-onnx-linux-x64@^1.13.8`
- `sherpa-onnx-node@1.13.8 -> sherpa-onnx-linux-arm64@^1.13.8`
- `sherpa-onnx-node@1.13.8 -> sherpa-onnx-win-ia32@^1.13.8`
- `@vscode/ripgrep@1.18.0 -> @vscode/ripgrep-darwin-x64@1.18.0`
- `@vscode/ripgrep@1.18.0 -> @vscode/ripgrep-darwin-arm64@1.18.0`
- `@vscode/ripgrep@1.18.0 -> @vscode/ripgrep-win32-arm64@1.18.0`
- `@vscode/ripgrep@1.18.0 -> @vscode/ripgrep-win32-ia32@1.18.0`
- `@vscode/ripgrep@1.18.0 -> @vscode/ripgrep-linux-x64@1.18.0`
- `@vscode/ripgrep@1.18.0 -> @vscode/ripgrep-linux-arm64@1.18.0`
- `@vscode/ripgrep@1.18.0 -> @vscode/ripgrep-linux-arm@1.18.0`
- `@vscode/ripgrep@1.18.0 -> @vscode/ripgrep-linux-ppc64@1.18.0`
- `@vscode/ripgrep@1.18.0 -> @vscode/ripgrep-linux-riscv64@1.18.0`
- `@vscode/ripgrep@1.18.0 -> @vscode/ripgrep-linux-s390x@1.18.0`
- `@vscode/ripgrep@1.18.0 -> @vscode/ripgrep-linux-ia32@1.18.0`
- `@deepseek-ai/libreoffice-kit@0.1.5 -> @deepseek-ai/libreoffice-kit-darwin-arm64@0.1.5`
- `@deepseek-ai/libreoffice-kit@0.1.5 -> @deepseek-ai/libreoffice-kit-darwin-x64@0.1.5`
- `@deepseek-ai/libreoffice-kit@0.1.5 -> @deepseek-ai/libreoffice-kit-wasm@0.1.5`
- `@deepseek-ai/libreoffice-kit@0.1.5 -> @deepseek-ai/libreoffice-kit-win32-arm64@0.1.5`
- `koffi@3.1.1 -> @koromix/koffi-linux-arm64@3.1.1`
- `koffi@3.1.1 -> @koromix/koffi-linux-ia32@3.1.1`
- `koffi@3.1.1 -> @koromix/koffi-linux-x64@3.1.1`
- `koffi@3.1.1 -> @koromix/koffi-linux-riscv64@3.1.1`
- `koffi@3.1.1 -> @koromix/koffi-freebsd-ia32@3.1.1`
- `koffi@3.1.1 -> @koromix/koffi-freebsd-x64@3.1.1`
- `koffi@3.1.1 -> @koromix/koffi-freebsd-arm64@3.1.1`
- `koffi@3.1.1 -> @koromix/koffi-openbsd-ia32@3.1.1`
- `koffi@3.1.1 -> @koromix/koffi-openbsd-x64@3.1.1`
- `koffi@3.1.1 -> @koromix/koffi-win32-ia32@3.1.1`
- `koffi@3.1.1 -> @koromix/koffi-win32-arm64@3.1.1`
- `koffi@3.1.1 -> @koromix/koffi-darwin-x64@3.1.1`
- `koffi@3.1.1 -> @koromix/koffi-darwin-arm64@3.1.1`
- `koffi@3.1.1 -> @koromix/koffi-linux-loong64@3.1.1`
- `@deepseek-ai/node-addon-system@0.1.2 -> @deepseek-ai/node-addon-system-darwin-arm64@0.1.2`
- `@deepseek-ai/node-addon-system@0.1.2 -> @deepseek-ai/node-addon-system-darwin-x64@0.1.2`
- `@deepseek-ai/node-addon-system@0.1.2 -> @deepseek-ai/node-addon-system-linux-x64@0.1.2`
- `@deepseek-ai/node-addon-system@0.1.2 -> @deepseek-ai/node-addon-system-linux-arm64@0.1.2`
- `proxy-agent-negotiate@1.1.0 -> kerberos@^2.0.0`
- `@google/genai@2.21.0 -> @modelcontextprotocol/sdk@^1.25.2`
- `sharp@0.35.4 -> @img/sharp-darwin-arm64@0.35.4`
- `sharp@0.35.4 -> @img/sharp-darwin-x64@0.35.4`
- `sharp@0.35.4 -> @img/sharp-freebsd-wasm32@0.35.4`
- `sharp@0.35.4 -> @img/sharp-libvips-darwin-arm64@1.3.3`
- `sharp@0.35.4 -> @img/sharp-libvips-darwin-x64@1.3.3`
- `sharp@0.35.4 -> @img/sharp-libvips-linux-arm@1.3.3`
- `sharp@0.35.4 -> @img/sharp-libvips-linux-arm64@1.3.3`
- `sharp@0.35.4 -> @img/sharp-libvips-linux-ppc64@1.3.3`
- `sharp@0.35.4 -> @img/sharp-libvips-linux-riscv64@1.3.3`
- `sharp@0.35.4 -> @img/sharp-libvips-linux-s390x@1.3.3`
- `sharp@0.35.4 -> @img/sharp-libvips-linux-x64@1.3.3`
- `sharp@0.35.4 -> @img/sharp-libvips-linuxmusl-arm64@1.3.3`
- `sharp@0.35.4 -> @img/sharp-libvips-linuxmusl-x64@1.3.3`
- `sharp@0.35.4 -> @img/sharp-linux-arm@0.35.4`
- `sharp@0.35.4 -> @img/sharp-linux-arm64@0.35.4`
- `sharp@0.35.4 -> @img/sharp-linux-ppc64@0.35.4`
- `sharp@0.35.4 -> @img/sharp-linux-riscv64@0.35.4`
- `sharp@0.35.4 -> @img/sharp-linux-s390x@0.35.4`
- `sharp@0.35.4 -> @img/sharp-linux-x64@0.35.4`
- `sharp@0.35.4 -> @img/sharp-linuxmusl-arm64@0.35.4`
- `sharp@0.35.4 -> @img/sharp-linuxmusl-x64@0.35.4`
- `sharp@0.35.4 -> @img/sharp-webcontainers-wasm32@0.35.4`
- `sharp@0.35.4 -> @img/sharp-win32-arm64@0.35.4`
- `sharp@0.35.4 -> @img/sharp-win32-ia32@0.35.4`
