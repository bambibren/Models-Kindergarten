# Models Kindergarten 开发约束

## 当前目标

维护“React 类 GPT Web + Remote ACP Agent + 常规单 Agent Runtime + MCP/Agent Skills”的 D2P-1 完整链路。D2P-1 在 V1.6 主链之上增加可管理 Agent、固定绑定 Session、受管 Skill/MCP、多 Provider ModelStudent 入园、Session 文件预览和 Context Experiment；旧版 `model-kindergarten-v1-codex` 仅是背景，不是当前实现规范。

## 必须保持

- Browser 与 Remote 之间只使用官方 ACP；
- 一个浏览器页面只有一个 ACP connection owner；
- `load` 完整回放；`resume` 默认零回放，携带当前 Turn 游标时只补齐断线增量；
- Remote 不保存 Web 投影，Web 不保存 Runtime 状态；
- Model Provider 不依赖 ACP；Remote 允许零模型启动，Ollama 与线上 API 都必须走统一入园；
- Evaluation 是独立职责模块但不建立独立进程、端口或容器；评测持久化失败不得改变 Agent Turn 结果；
- UI 组件不解释 Raw ACP；
- 每个 session 同时最多一个 prompt；
- 新增协议行为必须有测试。
- 文件 Tool 必须经过 `FileSandbox`；禁止绕过路径、大小和符号链接校验；
- 写入必须经过 `PermissionGate` 并遵守 Agent permission 配置，默认使用 ACP permission；AskUser 必须使用 ACP elicitation，二者不得混用。
- MCP 与 Skills 只能从 Remote Runtime 接入；不得改变 Browser 与 Remote 的 ACP 边界；
- MCP Tool 和 Skill Script 必须经过 ToolRuntime，不能直接从 AgentRunner 执行；
- MCP/Skill 配置、Secret、运行状态和能力快照必须分离，Secret 不得进入日志、Session 或评测 Trace。
- 受管 Secret 只能写入 AES-256-GCM 加密凭据库；本机源码使用仓库 `.local/secrets/mk_master_key`，容器使用 `/run/secrets/mk_master_key`。不得新增 Keychain 写入，也不得把主密钥提交到 Git、打进镜像或放进业务数据卷。

## D2P-1 实施边界

以下能力仍明确排除：

- Java/RCS、Channel Group、EventBus、SSE；
- `RunEvt` 或另一套 Command/Event envelope；
- Course、Memory 等未进入主链的领域对象；
- Plan、`update_plan`、Planner/Executor、Workflow/DAG；
- Runtime Timeline/Event Store、长期记忆、RAG 和多 Agent；

D2P-1 允许受控终端、网络搜索/读取、有限重试和外部依赖熔断；这些能力必须经过 ToolRuntime、权限策略和对应沙箱，不能从 ACP Adapter 或 Model Provider 绕过。

D2P-1 增加可变 Agent 配置、ModelStudent 目录与多 Provider 入园、固定绑定 Session、Session-scoped Artifact 预览、2～3 lane Context Experiment、三维人工注释与 Runtime 执行分。Context Experiment 只编排正式 Session/Prompt，不是 Workflow/DAG。

D2P-1 的模型入园实现 OpenAI 官方、自定义公网 HTTPS Responses、硅基流动 Chat Completions 与本机回环地址 Ollama；能力必须来自目标端点逐项体检，禁止按域名或模型名写死。Provider Preset 与 Protocol Adapter 必须分离，固定公网 Preset 不接受客户端 Base URL。Anthropic Messages 只保留扩展合同，不得显示为已支持。小说真实创作、Bearer Token 小说 MCP、自动评分调用、MCP 市场、自动升级、Tasks、MCP Apps、Skill 依赖安装或脚本自动执行仍不做。首页小说创作卡片保留为不可点击的调研占位。

## 代码风格

- 注释使用中文，解释边界、原因和不变量，不逐行翻译代码；
- 变量名简短、准确；避免多个同义词拼接成长驼峰；
- 一个模块只有一个清晰职责；
- 不为“未来也许需要”创建空抽象；
- 错误直接暴露，不偷偷降级到另一条行为路径。
