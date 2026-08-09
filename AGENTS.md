# Models Kindergarten 开发约束

## 当前目标

维护“React 类 GPT Web + Remote ACP Agent + 常规单 Agent Runtime + MCP/Agent Skills”的 V1.6 完整链路。旧版 `model-kindergarten-v1-codex` 仅是背景，不是当前实现规范。

## 必须保持

- Browser 与 Remote 之间只使用官方 ACP；
- 一个浏览器页面只有一个 ACP connection owner；
- `load` 完整回放，`resume` 零回放；
- Remote 不保存 Web 投影，Web 不保存 Runtime 状态；
- Model Provider 不依赖 ACP，默认演示必须调用本地小模型；
- UI 组件不解释 Raw ACP；
- 每个 session 同时最多一个 prompt；
- 新增协议行为必须有测试。
- 文件 Tool 必须经过 `FileSandbox`；禁止绕过路径、大小和符号链接校验；
- 写入必须使用 ACP permission，AskUser 必须使用 ACP elicitation，二者不得混用。
- MCP 与 Skills 只能从 Remote Runtime 接入；不得改变 Browser 与 Remote 的 ACP 边界；
- MCP Tool 和 Skill Script 必须经过 ToolRuntime，不能直接从 AgentRunner 执行；
- MCP/Skill 配置、Secret、运行状态和能力快照必须分离，Secret 不得进入日志、Session 或评测 Trace。

## V1.6 实施边界

以下能力仍明确排除：

- Java/RCS、Channel Group、EventBus、SSE；
- `RunEvt` 或另一套 Command/Event envelope；
- Student、Course、Memory 等未进入主链的领域对象；
- Plan、`update_plan`、Planner/Executor、Workflow/DAG；
- Runtime Timeline/Event Store、长期记忆、RAG、多 Agent 和 Artifact；

V1.6 允许受控终端、网络搜索/读取、有限重试和外部依赖熔断；这些能力必须经过 ToolRuntime、权限策略和对应沙箱，不能从 ACP Adapter 或 Model Provider 绕过。

V1.6 增加 MCP Host（stdio、Streamable HTTP、Tools、Resources、MRTR）和 Agent Skills（校验安装、渐进加载、资源读取）。不做 MCP 市场 UI、自动升级、Tasks、MCP Apps、Skill 依赖安装或脚本自动执行。

## 代码风格

- 注释使用中文，解释边界、原因和不变量，不逐行翻译代码；
- 变量名简短、准确；避免多个同义词拼接成长驼峰；
- 一个模块只有一个清晰职责；
- 不为“未来也许需要”创建空抽象；
- 错误直接暴露，不偷偷降级到另一条行为路径。
