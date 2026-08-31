# ModelStudent 入园设计

> 状态：正式入园链已支持 OpenAI 官方、自定义 Responses 与硅基流动；Ollama 仍由启动配置提供，Anthropic Messages 只保留扩展合同且不显示为可用。
> 更新：2026-08-15
> 适用：Models Kindergarten 正式模型入园、相关 Demo 与后续 Provider 扩展。
> 当前实现事实仍以 [ARCHITECTURE.md](ARCHITECTURE.md) 和 [TECHNICAL_PLAN.md](TECHNICAL_PLAN.md) 为准。

## 1. 决策摘要

正式“新模型入园”当前提供三个可用入口：

| 用户入口 | Provider Protocol | 当前状态 |
|---|---|---|
| OpenAI 官方 | `openai_responses` | 固定官方 API 根地址；复用 Responses Adapter 与主动能力体检 |
| 自定义 Responses 接口 | `openai_responses` | 可编辑公网 HTTPS Base URL；真实端点体检、Keychain、Catalog、Session/ACP 动态解析 |
| 硅基流动 | `openai_chat_completions` | 固定官方 API 根地址；独立 Chat Completions Adapter 与主动能力体检 |

本地 Ollama 继续作为启动配置模型，不进入本期管理入园页。Anthropic、Gemini、OpenRouter、阿里云百炼、Azure、Bedrock 与 Vertex AI 不显示为可用；其中 Anthropic 只保留 `anthropic_messages` Preset/Adapter 扩展位，不能冒充已实现能力。

模型供应商和协议适配必须分离：

```text
Provider preset / 用户连接
              ↓
ProviderConnection
              ↓ protocol
ModelProviderAdapter
  ├─ OllamaNativeAdapter
  ├─ ResponsesApiAdapter
  ├─ ChatCompletionsAdapter
  └─ AnthropicMessagesAdapter（未来）
              ↓
ModelStudent
```

OpenAI 官方与自定义 Responses 共享协议 Adapter，但使用不同 Endpoint 策略；硅基流动使用 Chat Completions Adapter。新增同协议服务时优先新增 Preset，只有 wire 语义确实不同才新增 Adapter。

## 2. 用户认知

页面用小白可以理解的语言解释：

- **服务商**：提供模型调用服务的平台。
- **API Key**：服务商发给用户的调用密码；调用额度和费用属于该服务商账号。
- **Base URL**：服务入口。内置服务商由 MK 预填；自定义接口才要求用户填写。
- **模型 ID**：服务商目录中的具体模型名称。一份连接通常可以接入多个 ModelStudent。

页面主流程固定为：

```text
选择模型来源
  → 配置并测试连接
  → 读取或填写模型 ID
  → 对选中模型做能力体检
  → 选择模型默认推理档位
  → 命名并确认入园
```

连接检测、能力体检和正式模型评分是三件不同的事。新入园模型显示“待评测”，不能用连接体检结果生成分数，也不能显示“0 分”。

## 3. 领域模型

产品仍然只向用户展示“模型”或“模型学生”。`ProviderConnection` 是内部复用对象，不新增用户可见的 Provider 管理概念。

```ts
type ProviderProtocol =
  | "ollama_native"
  | "openai_chat_completions"
  | "openai_responses"
  | "anthropic_messages";

type ConnectionState =
  | "unchecked"
  | "checking"
  | "ready"
  | "unavailable";

type CapabilityState =
  | "supported"
  | "unsupported"
  | "unverified";

interface ProviderConnection {
  id: string;
  presetId: "openai" | "custom_responses" | "siliconflow" | "anthropic";
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  credentialRef?: string;
  credentialHint?: string;
  state: ConnectionState;
  lastCheckedAt?: number;
}

interface ModelStudent {
  id: string;
  name: string;
  connectionId: string;
  providerModelId: string;
  capabilities: {
    streaming: CapabilityState;
    toolCalls: CapabilityState;
    usage: CapabilityState;
    reasoning: ModelReasoningCapability;
  };
  generationDefaults: {
    reasoningProfile: ConcreteReasoningProfile;
    temperature?: number;
  };
  state: "checking" | "ready" | "unavailable";
  score: number | null;
  admittedAt: number;
  lastVerifiedAt?: number;
}
```

正式公开体检结果使用协议中性的原生映射，不能继续把 Responses 的 `effort` 当成所有服务的共同字段：

```ts
interface ProviderCapabilitySnapshot {
  protocol: ProviderProtocol;
  adapterRevision: string;
  probeVersion: number;
  connectionFingerprint: string;
  reasoning: {
    capability: ModelReasoningCapability;
    nativeByProfile: Partial<Record<ConcreteReasoningProfile,
      Record<string, string | number | boolean>>>;
    acceptedNativeValues: Array<Record<string, string | number | boolean>>;
  };
}
```

`connectionFingerprint` 只覆盖 Preset、协议、规范化 Endpoint 与 Model ID，不包含 Key。`toggle` 用于 `think` / `enable_thinking` 布尔控制，`effort_levels` 用于真正的离散 effort，`token_budget` 用于原生预算；UI 不再把三者都叫作“思考强度”。Capability 中的 `defaultProfile` 保留目标端点体检得到的原始默认事实，不能因用户选择而改写。

推理不能继续使用单个 supported/unsupported 状态。Capability 必须保存控制方式、可用产品档位、体检原始默认和经确认的原生参数范围；用户从 `supportedProfiles` 中选择的有效模型默认值另存为 `ModelStudent.generationDefaults.reasoningProfile`。Session 覆盖与 Turn 快照由另一份领域契约负责，Agent 不保存推理强度。完整定义见 [Model Reasoning Policy](REASONING_POLICY.md)。

### 3.1 不变量

- 一条 `ProviderConnection` 可以被多个 ModelStudent 引用。
- Key 轮换只更新 Connection，不复制或重建所有 ModelStudent。
- ModelStudent 不保存 System Prompt、Skills、MCP、Memory、History 或 Agent 配置；`systemPrompt` 只能由 Agent 提供。
- ModelStudent 的 `generationDefaults` 保存用户选择的推理默认档位和可选 `temperature`；Session 唯一允许覆盖的模型执行配置是推理强度，不能覆盖温度。
- Agent 和 Session 语义不因模型入园而引入 AgentVersion/AgentRevision。
- Session 通过 `modelStudentId` 解析确切模型连接；Turn 开始时冻结实际 Provider 与推理映射。
- `credentialRef` 只由 Remote 返回为不透明引用；Web 永远拿不到 Secret 明文。

## 4. 页面结构

### 4.1 路由与入口

- 正式路由：`/models/new`；旧 Demo 路由只保留历史设计参考。
- 主入口：模型主页“新模型入园”按钮。
- 次入口：“我的 Models”中的“新模型入园”。
- 完成：回到模型主页，并选中新入园的 ModelStudent。
- 取消：回到来源页面；Demo 不保留未完成 Key。

### 4.2 页面布局

桌面使用与 Remote MCP 编辑页一致的左主右辅结构；移动端降为单列。

```text
┌──────────────────────────────────────────────────────┐
│ TopNav                                                │
├──────────────────────────────────────────────────────┤
│ ←  新模型入园           1 选择 · 2 连接 · 3 体检       │
│                                                      │
│ ┌────────────────────────────┐ ┌───────────────────┐ │
│ │ 主操作区                    │ │ 状态与解释         │ │
│ │ Provider / Form / Model     │ │ 检测阶段、能力结果 │ │
│ │                             │ │ Key 安全说明       │ │
│ └────────────────────────────┘ └───────────────────┘ │
└──────────────────────────────────────────────────────┘
```

### 4.3 组件树

```text
ModelAdmissionPage
├── AdmissionHeading
├── ProviderCards
├── ConnectionForm
│   ├── OpenAIFields
│   ├── SiliconFlowFields
│   └── ResponsesFields
├── ModelIdField
├── CapabilityProbePanel
├── GenerationDefaultsFields
│   ├── DefaultReasoningProfileSelect
│   └── TemperatureField（协议支持时）
└── AdmissionActions
```

ProviderCards 的数据来自 `GET /model-provider-presets`；Web 不维护第二份可用服务商列表。Remote 只返回同时拥有真实 Adapter 的 `ready` Preset，`planned` 项不会出现在页面。

## 5. 三种可用入口

### 5.1 OpenAI 官方

字段：

- OpenAI API Key。
- 模型 ID。
- Base URL 由 Remote 固定为官方 API 根地址，浏览器不能提交或覆写。
- 使用与自定义 Responses 相同的 Adapter 与 Probe，不另外复制 Runtime。

### 5.2 自定义 Responses 接口

字段：

- HTTPS Base URL。
- API Key。
- 模型 ID。

协议固定为 `openai_responses`，不做任意协议自动识别。模型 ID 当前手填；模型列表发现是独立后续能力，页面不能用 `discoverable` 文案暗示已经实现。

### 5.3 硅基流动

默认字段：

- API Key。
- Base URL 固定为 `https://api.siliconflow.cn/v1`，默认不显示。
- 模型 ID 当前手填；后续可通过独立 discovery API 接入 `/models?type=text&sub_type=chat`。
- 推理使用 `/chat/completions`；Tool Call 使用 Chat Completions `tools`/`tool_calls` 语义。

页面只给出一般性安全说明：凭据与体检内容发送到当前选择的服务，自定义地址必须可信。产品文案不引用某个客户端、配置文件或单次代理地址作为反例。

## 6. 页面状态机

```ts
type AdmissionPhase =
  | "selecting_provider"
  | "editing_connection"
  | "testing_connection"
  | "selecting_model"
  | "probing_capabilities"
  | "ready"
  | "saving"
  | "failed";
```

```text
selecting_provider
  → editing_connection
  → testing_connection
  → selecting_model
  → probing_capabilities
  → ready
  → saving
  → 返回模型主页
```

任何连接字段改变都必须使旧的成功结果失效，并回到 `editing_connection`。失败保留当前输入和来源选择，允许原地重试。

## 7. 检测与能力体检

真实开发时，检测拆成独立事实：

1. 地址与凭据有效。
2. 模型发现成功，或用户手填模型 ID。
3. 选中模型能完成最小生成。
4. 流式输出可结束。
5. Tool Call 能产生结构化调用。
6. Usage 是否提供 input/output/cached/reasoning 细项。
7. 推理控制属于 fixed、effort levels 还是 token budget；支持哪些档位，体检原始默认档位和原生参数分别是什么。
8. 用户从经体检确认的档位中选择 `generationDefaults.reasoningProfile`；未主动修改时以体检原始默认值初始化。协议允许 temperature 时将其保存为 ModelStudent 默认值，而不是 Session 覆盖。

Tool Call 体检使用无副作用的 `mk_capability_probe`，禁止调用文件、网络、MCP 或其他真实 Tool。协议支持强制 Tool Choice 时才做确定性验证；不能强制时显示“未验证”，不能误判“不支持”。

能力状态在模型附近展示，不增加独立 Runtime 面板：

- 流式输出：支持 / 不支持 / 未验证。
- Tool Calling：支持 / 不支持 / 未验证。
- Token Usage：支持 / 不报告 / 未验证。
- 推理控制：固定 / 可调 / 未验证；可调时列出经体检确认的产品档位。

体检面板展示 Provider 原始默认事实；入园确认区展示用户将要保存的模型默认档位。二者含义不同，即使初始值相同也不能共用一个可变字段。入园后 Session 的 `auto` 文案按有效默认值显示，例如“跟随模型默认 · 均衡”。

模型可在 Tool Call 不支持时入园，但必须显示“仅聊天”，并在选择需要 Tools 的 Agent 时阻止误用或给出明确警告。

## 8. 协议 Adapter 边界

协议 Adapter 与 Preset 分离：

```text
OllamaNativeAdapter
ChatCompletionsAdapter
ResponsesApiAdapter
AnthropicMessagesAdapter（未来）
```

### 8.1 公共连接层

负责：

- SecretRef 解析和 Bearer 鉴权。
- Base URL、超时、有限重试和熔断。
- 错误体裁剪与 Secret 脱敏。
- SSE 单行、单事件、总流和 HTTP 错误体大小上限。
- SSRF、DNS 重绑定、重定向和私网策略。
- 连接测试和能力体检编排。

### 8.2 ChatCompletionsAdapter

负责把硅基流动协议映射为现有 `ModelEvent`：

- `choices[].delta.content` → `text_delta`。
- `reasoning_content` → `thinking_delta`。
- `tool_calls[index]` 的 name/arguments 增量按 index/id 聚合。
- Tool Result → `role=tool` 消息。
- Usage → input/output token 事实。
- `finish_reason` →统一 finish/error。

硅基流动体检不会按 Model ID 猜推理能力：只有 `enable_thinking=false/true` 都完成，并且输出可观察到从无 `reasoning_content` 到有 `reasoning_content` 的变化时，才声明 `toggle`；否则保持 fixed。未来增加 `thinking_budget` 或 `reasoning_effort` 也必须走目标 Endpoint 主动体检。

### 8.3 ResponsesApiAdapter

负责把 Responses 协议映射为现有 `ModelEvent`：

- output text delta → `text_delta`。
- reasoning/summary delta → `thinking_delta`。
- function call name/arguments 增量按 call id 聚合。
- function call output 回传。
- input/output/cached/reasoning usage 映射。
- response completed/failed/cancelled 终止语义。

Responses Adapter 已进入真实 Provider resolver。入园体检会对目标 endpoint 依次验证正式流式终态、`low/medium/high/xhigh`、无副作用 Tool Call 及 `function_call_output` 续轮，并将实测的 `nativeByProfile` 持久化到 ModelStudent；同一 Model ID 在不同 Preset/Base URL 上会独立体检，不共享名称 preset。`store:false` 下的 Provider continuation 使用协议中性信封持久化，只有生成它的确切 ModelStudent/Adapter 可以解释；公开 Session、ACP、Context disclosure、Observation 和 Evaluation 只获得剥离或脱敏投影。上线边界见 [Model Reasoning Policy](REASONING_POLICY.md#10-自定义-responses-入园与-tool-loop-门禁)。

Provider 上游使用 SSE 不改变产品边界：Browser 与 Remote 之间仍然只使用 ACP；Browser 不直接连接硅基流动、自定义 Base URL 或任何 Provider SSE。

## 9. Secret 与网络安全

- 正式页面中，Key 只从密码输入框提交给 Remote；测试成功前仅在页面/Remote 瞬时内存中保留，确认入园后写入 AES-256-GCM 加密凭据库。
- Key 不得进入 ModelStudent JSON、Session、Context Summary、Token 统计、Evaluation Trace、URL、日志、`localStorage` 或 `sessionStorage`。
- 持久层只保存 `credentialRef` 与脱敏尾号；保存后只能替换或删除，不能再次读取明文。
- 本机源码、Docker 预演和云端使用同一个 `EncryptedFileSecretStore`；三者只通过部署档位切换主密钥文件路径。
- 预设的硅基流动 Base URL 不允许普通用户修改。
- 自定义云端 Base URL 必须是 HTTPS；Ollama 只对受控本机/私网连接类型允许 HTTP。
- Provider 原始错误可能包含 Header、URL 参数或请求片段，返回 Web 前必须脱敏。
- 生产 Adapter 默认禁止重定向；不能把可选重定向开关宣传为跨 Origin 安全能力。
- 主密钥不得进入 Git、容器镜像或业务数据卷；它与 `DATA_DIR/secure/credentials.enc` 必须分开保存。历史 Keychain 项只允许读取迁移，正式链路不再写入。

## 10. 错误投影

```ts
type ModelConnectionErrorCode =
  | "endpoint_unreachable"
  | "authentication_failed"
  | "permission_denied"
  | "billing_required"
  | "rate_limited"
  | "model_not_found"
  | "protocol_mismatch"
  | "request_invalid"
  | "timeout"
  | "provider_overloaded"
  | "tool_unsupported";
```

用户默认看到可行动文案；脱敏后的上游信息放在“查看技术详情”中。页面不得只显示笼统的“连接失败”。

## 11. Demo 与正式功能边界

`apps/web/src/demo/**` 仍是确定性设计演示，不请求 Remote，也不代表真实连接结果；其中保存的示例 ModelStudent 不含 Key。正式 `/models/new` 则调用 Control API 完成体检与入园，并由 Remote 持有 Provider 连接、Secret、Catalog 与 Session/ACP 运行接线。

两者不得共享模拟状态或凭据：

- Demo 只演示页面状态，不声称已连接服务商；
- 正式页面不读取 Demo `sessionStorage`，也不按输入内容伪造成功；
- Browser 不直连 Provider，不持久化 Key，不消费上游 SSE；
- 正式新生由 Remote 保存并在模型主页、“我的 Models”和新 Session 中使用。

## 12. 实施状态与后续分期

当前工作树已经完成 Phase A、Phase B 的 OpenAI Responses 与 SiliconFlow Chat Completions，以及 Phase C 的手填 Model ID、体检、安装、Catalog 和 Session/ACP 动态解析。模型目录发现、Ollama 管理入园、Anthropic Messages、Key 轮换与重新体检仍是后续范围。

### Phase A：管理领域与 Secret

- ModelStudent Repository。
- ProviderConnection Repository。
- SecretStore write/replace/delete。
- 只返回 credential hint 的管理契约。

### Phase B：协议 Adapter

- 将现有 Ollama 单实例改为按 Connection resolve。
- 将已有 ResponsesApiAdapter（含 opaque reasoning continuation）接入受管 Connection，并实现目标 endpoint 的完整体检门禁；协议核心已有实现。
- 实现 ChatCompletionsAdapter，并由硅基流动 preset 使用。
- 建立共享连接层和错误归一化。

### Phase C：入园与会话接线

- 连接测试、手填模型 ID、模型体检；模型发现另行实现。
- Session 保存 `modelStudentId`。
- Runtime 在 Prompt Turn 开始前解析确切 Provider。
- 我的 Models 已支持列出与删除；替换 Key、重新检测和停用仍是后续管理能力。

### Phase D：验证与迁移

- Provider contract tests 和 SSE fixture tests。
- Tool Call 参数乱序聚合测试。
- Secret 泄漏扫描。
- 自定义 URL SSRF/重定向/DNS rebinding 测试。
- 旧环境变量 Ollama 配置迁移为默认 Connection 与 ModelStudent。
- AnthropicMessagesAdapter 与对应 tool_use/tool_result、thinking signature continuation。

## 13. 验收标准

### Demo

- 三个入口均可完成可点击流程。
- 每个入口至少展示 editing、testing、failed、selecting/probing、ready 状态。
- 字段改变会使旧检测结果失效。
- 新生显示“待评测”，不显示“0 分”。
- 页面刷新后新生仍可从 Demo 模型列表读取，但存储中没有 Key 原文。
- 560px 以下单列且无横向溢出。

### 真实功能

- Browser 不接触 Provider Key 或上游 SSE。
- Connection、手填 Model ID、最小生成和 Tool Call 事实分别可观测；模型目录发现未实现时不得显示为成功步骤。
- Tool Calling 不支持时不影响纯聊天入园，但不能伪装成 Agent 工具可用。
- 同一 Connection 可以新增多个 ModelStudent。
- 任何 Secret 不进入 Session、Context、Trace 或日志。
- 推理能力按 [Model Reasoning Policy](REASONING_POLICY.md) 持久化，未知自定义模型不会从名称猜测 native effort。
- ModelStudent 同时保存不可伪造的 capability probe 与用户选择的 `generationDefaults.reasoningProfile`；后者必须属于该模型的 `supportedProfiles`。
- Agent 不保存推理强度或 temperature；Session 只能覆盖推理强度，Runtime 的 system prompt 只能来自 Agent。
- OpenAI 官方和自定义 Responses 复用同一个协议 Adapter；固定 Preset 不接受浏览器 Base URL。
- 硅基流动的能力来自 Chat Completions 主动体检，不套用 Responses effort 表。
- `GET /model-provider-presets` 只返回拥有真实 Adapter 的 ready 项；未来 Claude 接入不改入园状态机、Secret、Repository、Catalog、Session 或 ACP。

## 14. 官方依据

- OpenAI Responses API 与鉴权：<https://platform.openai.com/docs/api-reference/responses>
- SiliconFlow OpenAI Chat Completions 快速开始：<https://docs.siliconflow.cn/en/userguide/quickstart>
- SiliconFlow Function Calling：<https://docs.siliconflow.cn/en/userguide/guides/function-calling>
- SiliconFlow 模型目录：<https://docs.siliconflow.cn/en/api-reference/models/get-model-list>
- Ollama 本地模型目录：<https://docs.ollama.com/api/tags>
