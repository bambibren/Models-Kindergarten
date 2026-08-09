# MCP 入门与产品能力手册

> 本文以 MCP `2026-07-28` 为主线，先讲产品语义，再讲最小协议链路，最后映射到 Models Kindergarten。旧版 MCP 的差异单独列出，避免把过时实现当成新项目设计依据。

## 1. 先用一句话理解 MCP

MCP（Model Context Protocol）是 **AI 应用连接外部能力的标准协议**。

它解决的是：

> 一个 Agent 应用怎样发现外部程序能做什么、读取它提供的数据、调用它的操作，并用统一格式接收结果。

它不负责训练模型，也不规定 Agent 怎样思考。

```text
没有 MCP
Agent ──GitHub 私有适配代码──► GitHub API
      ──数据库私有适配代码──► Database
      ──Slack 私有适配代码──► Slack API

使用 MCP
Agent Host ──统一 MCP Client──► GitHub MCP Server
                             ├─ Database MCP Server
                             └─ Slack MCP Server
```

这里的 MCP Server 不一定是云服务器。它也可以是 Host 在用户电脑上启动的一个本地子进程。

官方定义中，MCP 只负责上下文与能力交换，不决定 Host 如何选择模型、管理上下文或实现 Agent Runtime。[官方架构说明](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture)

## 2. 三个参与者分别是什么

```text
用户
  ↓
MCP Host（用户真正使用的 AI 产品）
  ├─ MCP Client A ──► MCP Server A
  ├─ MCP Client B ──► MCP Server B
  └─ Model + Agent Runtime + UI + Permission
```

| 角色 | 产品语义 | 例子 |
| --- | --- | --- |
| MCP Host | 完整 AI 应用，管理模型、会话、UI、权限和多个 Server | Claude Desktop、VS Code、Models Kindergarten Remote |
| MCP Client | Host 内部的协议连接组件，通常一个 Server 对应一个 Client 对象 | `McpClientManager` 管理的单个 Client |
| MCP Server | 把某个系统的能力包装为 MCP primitives 的程序 | 文件系统、GitHub、数据库、Sentry Server |

最容易混淆的点：

- MCP Client 不是聊天 UI；它是 Host 内部的协议模块。
- MCP Server 不等于 Agent；它通常只提供一个领域的工具和数据。
- 一个 Host 可以同时组合多个 Server，模型看到的是 Host 合并后的能力目录。

## 3. 一个最小 MCP 实现包含什么

需要区分两个“最小实现”。

### 3.1 最小 MCP Server

一个只提供 Tool 的最小 Server 包含：

```text
1. Server 身份和协议版本
2. 一种 Transport
3. 能力发现
4. tools/list
5. tools/call
6. 一个 Tool Handler
```

例如天气 Server 只提供一个 `get_weather`：

```json
{
  "name": "get_weather",
  "description": "查询指定城市的当前天气",
  "inputSchema": {
    "type": "object",
    "properties": {
      "city": { "type": "string" }
    },
    "required": ["city"],
    "additionalProperties": false
  }
}
```

调用时，Client 发送：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "get_weather",
    "arguments": { "city": "上海" }
  }
}
```

Server 可以返回给人看的 `content`、给程序消费的 `structuredContent`，以及表示 Tool 自身执行失败的 `isError`。

这个 Server 本身不需要：

- 聊天页面；
- 大模型 API；
- Agent Tool Loop；
- Session 或长期记忆；
- Permission UI；
- Benchmark。

这些都属于 Host 产品，而不是最小 MCP Server。

### 3.2 最小 MCP Host 产品链路

只有 Server 还不能形成用户可用的 Agent。最小 Host 还需要：

```text
配置或选择 Server
  → 建立 Client
  → 发现 Server 能力
  → 把 Tool Schema 注册给模型
  → 模型产生 Tool Call
  → Host 校验参数与权限
  → MCP Client 调用 Server
  → Tool Result 加入模型上下文
  → 模型生成最终回答
  → UI 展示执行过程和结果
```

因此，“接入了 MCP SDK”和“做完了 MCP 产品接入”不是一回事。SDK 主要处理协议；Host 仍要处理模型适配、权限、安全、上下文和 UI。

## 4. MCP 的两层结构

```text
Data Layer
├─ JSON-RPC 请求、响应、通知
├─ 能力与版本发现
├─ Tools / Resources / Prompts
└─ Elicitation / Utilities / Extensions

Transport Layer
├─ stdio
└─ Streamable HTTP
```

### 4.1 Data Layer

定义“消息是什么意思”。无论数据走本地进程还是网络，核心方法都采用 JSON-RPC 语义。

当前协议核心是无状态的：请求携带协议版本、Client 信息和相关能力元数据；Host 可以先调用 `server/discover` 获取 Server 支持的版本、身份和能力。[2026-07-28 版本说明](https://blog.modelcontextprotocol.io/posts/2026-07-28/)

### 4.2 Transport Layer

定义“消息怎样到达另一端”。

| Transport | 产品形态 | 适合场景 | 主要风险 |
| --- | --- | --- | --- |
| stdio | Host 启动本地子进程，通过 stdin/stdout 通信 | IDE、本地文件、开发工具、桌面 Agent | 子进程权限、文件访问、环境变量、stdout 被日志污染 |
| Streamable HTTP | 独立远程服务，通过 HTTP POST，可选 SSE 流 | SaaS、企业服务、多人共享服务 | OAuth、租户隔离、SSRF、网络故障、服务限流 |

Transport 变化不会把 Tools 变成另一种协议。相同的 `tools/list` 和 `tools/call` 可以运行在两种 Transport 上。[官方 Transport 说明](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture#transport-layer)

## 5. Server 可以提供的三种核心能力

官方把 Server primitives 分为 Tools、Resources、Prompts。它们最重要的差别不是数据格式，而是 **由谁决定何时使用**。[官方 Server 概念](https://modelcontextprotocol.io/docs/2026-07-28/learn/server-concepts)

| Primitive | 谁控制 | 产品功能 | 典型 UI |
| --- | --- | --- | --- |
| Tool | Model-controlled | 执行动作或查询 | Tool Call 卡片、权限确认、结果展开 |
| Resource | Application-controlled | 给模型或用户提供只读上下文 | 资源选择器、附件、上下文面板、预览 |
| Prompt | User-controlled | 提供可复用工作流模板 | Slash Command、命令面板、模板表单 |

### 5.1 Tools：让模型做事

Tools 是带 JSON Schema 的函数接口，例如：

- `search_issues(query)`；
- `create_calendar_event(...)`；
- `read_database_schema()`；
- `deploy_service(environment)`。

基本方法：

```text
tools/list  → 发现 Tool 定义
tools/call  → 执行一个 Tool
```

产品上还需要 Host 决定：

- 哪些 Tool 对当前 Agent 可见；
- 哪些可以自动执行；
- 哪些必须询问用户；
- Tool Input/Output 怎样展示；
- Tool 失败后是否继续模型循环。

MCP Tool 描述的是能力接口，不自动等于安全授权。

### 5.2 Resources：让应用取得上下文

Resources 是由 URI 标识的只读数据，例如：

```text
file:///project/README.md
db://schema/orders
calendar://events/2026-08
docs://product/authentication
```

基本能力：

```text
resources/list              → 固定资源目录
resources/templates/list    → 带参数的 URI 模板
resources/read              → 读取内容
completion/complete         → 为参数提供输入建议
subscriptions/listen        → 订阅资源或能力变化
```

Resource 并不意味着“全部塞进 System Prompt”。Host 可以：

- 让用户手动选择；
- 只把元数据放进上下文；
- 搜索或裁剪后再注入；
- 由 Agent 按需读取；
- 仅在独立预览面板展示。

因此 Resource 是数据访问协议，Context Engineering 决定这些数据最终如何进入模型。

### 5.3 Prompts：让用户选择标准工作流

Prompts 是 Server 提供的参数化模板，例如：

```text
/review-pull-request
/plan-vacation
/summarize-meetings
```

基本方法：

```text
prompts/list → 发现模板
prompts/get  → 填入参数并取得完整模板
```

Prompt 通常应该由用户显式选择，而不是像 Tool 一样让模型静默调用。Host 可以把它做成 Slash Command、快捷操作或结构化表单。

## 6. Client 可以向 Server 提供什么

### 6.1 Elicitation：Server 中途询问用户

当 Tool 缺少必要信息时，Server 不必直接失败。它可以暂停原请求，让 Host 向用户收集信息，再带着答案重试原请求。

```text
tools/call: book_hotel
  ↓
Server: 需要房型和最终确认
  ↓ Elicitation / MRTR
Host: 展示表单或外部 URL
  ↓
User: 海景房，确认预订
  ↓
Host 重试原 tools/call
  ↓
Server: 完成预订
```

Elicitation 有两种产品形态：

| 模式 | 用途 | UI |
| --- | --- | --- |
| Form | 普通结构化信息、选择和确认 | 文本框、下拉框、复选框、确认按钮 |
| URL | OAuth、支付、凭证等敏感的站外流程 | 显示完整 URL，经用户同意后打开 |

敏感凭证不应通过 Form 进入聊天上下文；应使用 URL 模式让数据直接留在目标网站。[官方 Elicitation 说明](https://modelcontextprotocol.io/docs/2026-07-28/learn/client-concepts#elicitation)

### 6.2 已弃用的 Client 能力

`2026-07-28` 已弃用 Roots、Sampling 和 Logging：

- Roots：只表示建议访问范围，不是真正沙箱；新实现应通过 Tool 参数、Resource URI、Server 配置和操作系统沙箱表达范围。
- Sampling：过去允许 Server 反向请求 Host 的模型；新实现建议 Server 直接连接模型 Provider。
- Logging：新实现建议 stdio 写 `stderr`，远程服务使用 OpenTelemetry。

它们仍可能出现在旧 Server 和旧教程中，但不应该成为 Models Kindergarten 新功能的设计中心。

## 7. 横切能力与高级扩展

### 7.1 Notifications 与进度

Server 的 Tool 或 Resource 目录可能动态变化。Host 可以订阅通知，而不是永远使用启动时缓存。

产品上可以表现为：

- Tool 目录自动刷新；
- Resource 内容更新提示；
- 长操作进度条；
- Server 连接状态变化。

### 7.2 Tasks 扩展

普通 Tool Call 适合短请求。部署、CI、批处理等可能持续几分钟或几小时，MCP Tasks 用持久化 `taskId` 表达异步执行：

```text
working → input_required → working → completed
                    └──────────────→ failed / cancelled
```

它支持断线后查询、轮询状态、中途补充输入和取消，适合部署任务、批量处理与人工审批。[官方 Tasks 扩展](https://modelcontextprotocol.io/extensions/tasks/overview)

### 7.3 MCP Apps 扩展

普通 Tool Result 主要是文本、媒体和结构化数据。MCP Apps 允许 Tool 关联 `ui://` Resource，让 Host 在对话中渲染沙箱 iframe：

- 图表和数据探索；
- 配置表单；
- PDF、视频、3D 预览；
- 监控面板；
- 多步骤审批界面。

它不是“Server 随便返回 React 组件”，而是 Host 控制沙箱、CSP、权限和 postMessage 协议。[官方 MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)

### 7.4 Authorization 扩展

远程 MCP 常见的是用户 OAuth；企业或机器之间还可能使用 Client Credentials、Enterprise-Managed Authorization。授权解决“谁可以连接 Server”，Tool Permission 解决“这次操作是否允许执行”，两者不是同一层。

### 7.5 Registry 与安装生态

Registry 保存 Server 元数据、包地址、远程 URL 和安装说明；npm、PyPI、Docker Hub 等才存放实际代码。官方 Registry 只验证发布命名空间并托管元数据，不替 Host 完成代码安全审查。[官方 Registry 说明](https://modelcontextprotocol.io/registry/about)

产品上的完整安装链通常还要做：

```text
搜索 → 来源展示 → 风险提示 → 安装 → 配置 Secret
     → 选择能力 → Permission Policy → 启用 → 更新/卸载
```

## 8. 从产品角度给 MCP Server 分类

下面不是协议官方类型，而是做产品选型时更实用的分类。

| 产品类型 | 主要能力 | 例子 |
| --- | --- | --- |
| 只读数据型 | Resources、只读 Tools | 文档库、数据库 Schema、日志查询 |
| 操作集成型 | 有副作用 Tools、OAuth | GitHub、Slack、日历、CRM |
| 本地开发型 | stdio、文件/进程能力 | 文件系统、Git、终端、代码索引 |
| 远程平台型 | Streamable HTTP、多租户、OAuth | Sentry、云平台、企业 SaaS |
| 长任务型 | Tools + Tasks | CI、部署、批处理、模型训练 |
| 交互应用型 | Tools + Resources + MCP Apps | Dashboard、设计器、审批表单 |

同一个 Server 可以同时属于多类。例如云部署 Server 既是操作集成型，也是远程平台型和长任务型。

## 9. MCP 不替你解决什么

| 问题 | MCP 是否规定 | 谁负责 |
| --- | --- | --- |
| 模型选哪个 Tool | 否 | 模型 + Host Prompt/Context |
| Tool 是否需要用户批准 | 只提供表达基础，不给业务策略 | Host Permission Policy |
| 本地进程是否真的被隔离 | 否 | Host OS Sandbox |
| Resource 是否进入上下文 | 否 | Host Context Engineering |
| Tool 失败是否重试 | 否 | Host Runtime 或 Server |
| 对话历史和记忆 | 否 | Agent Runtime |
| Tool 卡片怎样渲染 | 否 | Host UI Projection |
| Server 是否可信 | 否 | 安装、审计、签名与运营治理 |
| Agent 效果如何评测 | 否 | Evaluation / Benchmark |

MCP 标准化的是边界，不是整个 Agent 产品。

## 10. MCP、ACP、Agent Skills 的区别

```text
Browser ──ACP──► Agent Host / Remote
                    ├─ Model + Agent Runtime
                    ├─ MCP Client ──MCP──► MCP Server
                    └─ Agent Skills
```

| 概念 | 解决的问题 | 主要内容 |
| --- | --- | --- |
| ACP | 用户端怎样与远程 Agent 交互 | Session、Prompt、流式消息、Tool 状态、Permission、Elicitation |
| MCP | Agent Host 怎样连接外部能力 | Tools、Resources、Prompts、Transport、Auth、Extensions |
| Agent Skills | Agent 怎样按需学习一套过程知识 | 指令、references、assets、scripts |

一个 Skill 可以告诉模型“怎样使用 GitHub MCP Tools 完成发布流程”，但 Skill 自己不是 GitHub 网络协议，也不会自动获得 Tool 权限。

## 11. Models Kindergarten 当前实现覆盖

```text
Browser
  ⇅ ACP
Remote = MCP Host
  ├─ McpClientManager
  │   ├─ Client A → stdio Server
  │   └─ Client B → Streamable HTTP Server
  ├─ RuntimeCapabilityCatalog
  ├─ ToolRuntime / Permission / Sandbox
  ├─ ContextAssembler
  └─ ModelProvider → qwen3:8b
```

| 能力 | 当前状态 | 用户能得到什么 |
| --- | --- | --- |
| stdio / Streamable HTTP | 已实现 | 可连接本地或远程 Server |
| modern / legacy 协商 | 已实现 | 可兼容不同协议代际 |
| Tools | 已实现 | 模型可发现、调用并在 UI 查看结果 |
| Resources | 已实现固定 Resource | 可元数据展示、按需读取或 preload |
| Resource Templates / Completion | 未实现 | 暂无动态 URI 资源选择器 |
| Prompts | 仅发现和快照 | 暂无 Slash Command/模板 UI |
| Elicitation | 最小文本映射 | Server 可通过现有 AskUser 获取单项信息 |
| 多字段 Form / URL 完整交互 | 未实现 | 暂无 Schema 驱动表单和站外授权交互 |
| Notifications / Subscriptions | 未实现 | Server 能力变化需下一次连接生效 |
| Tasks | 未实现 | 暂不承载断线可恢复的长任务 |
| MCP Apps | 未实现 | 暂不渲染第三方交互 iframe |
| Registry / 市场 UI | 未实现 | 当前使用显式 JSON 配置 |
| OAuth 浏览器流程 | 未实现 | 当前读取预先保存的 Access Token |
| Permission / Sandbox | Host 自有实现 | MCP Tool 仍经过统一安全链路 |
| Runtime Trace | 已实现 | 可复现 Tool Schema、Server revision 和执行结果 |

具体代码结构、安全策略和配置方式见 [MCP 与 Agent Skills 开发设计](MCP_SKILLS.md)。

## 12. 建议的学习顺序

```text
第一步：只理解 Host / Client / Server
第二步：亲手实现一个只有 tools/list + tools/call 的 stdio Server
第三步：观察 Host 如何把 Tool Schema 交给模型并完成 Tool Loop
第四步：加入 Resource，比较“应用选择上下文”和“模型调用 Tool”
第五步：加入 Prompt，理解 user-controlled workflow
第六步：加入 Elicitation 和 Permission，理解用户控制边界
第七步：再学习 OAuth、Tasks、Apps、Registry 与企业治理
```

学完前三步，就已经理解 MCP 的最小核心；后面的能力都是在这条链路上拓展产品体验、远程服务和治理能力。
