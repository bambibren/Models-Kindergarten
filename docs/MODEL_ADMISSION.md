# ModelStudent 入园设计

> 状态：产品与 Demo 方案已确认；真实 Remote、SecretStore 写入和云端 Provider Adapter 尚未实现。  
> 更新：2026-08-11  
> 适用：Models Kindergarten 最新 Demo，以及后续真实模型接入开发。  
> 当前实现事实仍以 [ARCHITECTURE.md](ARCHITECTURE.md) 和 [TECHNICAL_PLAN.md](TECHNICAL_PLAN.md) 为准。

## 1. 决策摘要

“新模型入园”只支持三个用户入口：

| 用户入口 | Provider Protocol | 当前状态 |
|---|---|---|
| 本地 Ollama | `ollama_native` | 真实 Runtime 已有单实例实现；管理页面未实现 |
| 硅基流动 | `openai_chat_completions` | Demo 模拟；真实 Adapter 未实现 |
| 自定义 Responses 接口 | `openai_responses` | Demo 模拟；真实 Adapter 未实现 |

本期不展示、不承诺兼容 OpenAI 官方入口、Anthropic、Gemini、DeepSeek、OpenRouter、阿里云百炼、Azure、Bedrock 或 Vertex AI。其他服务即使协议相似，也不作为品牌级兼容范围。

模型供应商和协议适配必须分离：

```text
Provider preset / 用户连接
              ↓
ProviderConnection
              ↓ protocol
ModelProviderAdapter
  ├─ OllamaNativeAdapter
  ├─ ChatCompletionsAdapter
  └─ ResponsesApiAdapter
              ↓
ModelStudent
```

不为硅基流动、自定义代理分别复制完整 Runtime；它们只提供不同的连接预设并复用对应协议 Adapter。

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
  → 命名并确认入园
```

连接检测、能力体检和正式模型评分是三件不同的事。新入园模型显示“待评测”，不能用连接体检结果生成分数，也不能显示“0 分”。

## 3. 领域模型

产品仍然只向用户展示“模型”或“模型学生”。`ProviderConnection` 是内部复用对象，不新增用户可见的 Provider 管理概念。

```ts
type ProviderProtocol =
  | "ollama_native"
  | "openai_chat_completions"
  | "openai_responses";

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
  presetId: "ollama" | "siliconflow" | "custom_responses";
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
    reasoning: CapabilityState;
  };
  state: "checking" | "ready" | "unavailable";
  score: number | null;
  admittedAt: number;
  lastVerifiedAt?: number;
}
```

### 3.1 不变量

- 一条 `ProviderConnection` 可以被多个 ModelStudent 引用。
- Key 轮换只更新 Connection，不复制或重建所有 ModelStudent。
- ModelStudent 不保存 System Prompt、Skills、MCP、Memory、History 或 Agent 配置。
- Agent 和 Session 语义不因模型入园而引入 AgentVersion/AgentRevision。
- Session 后续真实接线通过 `modelStudentId` 解析确切模型连接；本 Demo 只模拟选择结果。
- `credentialRef` 只由 Remote 返回为不透明引用；Web 永远拿不到 Secret 明文。

## 4. 页面结构

### 4.1 路由与入口

- 路由：`/demo/model-admission`
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
├── AdmissionStepper
├── ProviderCards
├── ConnectionForm
│   ├── OllamaFields
│   ├── SiliconFlowFields
│   └── ResponsesFields
├── ModelPicker
├── CapabilityProbePanel
└── AdmissionActions
```

## 5. 三种入口

### 5.1 本地 Ollama

默认字段：

- 服务地址：`http://127.0.0.1:11434`
- 不显示 API Key。
- 连接成功后通过 `/api/tags` 读取本地模型。
- 必须提示：`localhost` 指 MK Remote 所在机器，不一定是浏览器所在机器。

Demo 固定模拟发现 `qwen3:8b` 和 `deepseek-r1:8b`，不发网络请求。

### 5.2 硅基流动

默认字段：

- API Key。
- Base URL 固定为 `https://api.siliconflow.cn/v1`，默认不显示。
- 测试连接后从 `/models?type=text&sub_type=chat` 读取候选模型。
- 推理使用 `/chat/completions`；Tool Call 使用 Chat Completions `tools`/`tool_calls` 语义。

Demo 固定模拟候选目录，不保存 Key 原文。

### 5.3 自定义 Responses 接口

字段：

- 连接名称。
- HTTPS Base URL。
- API Key。
- 模型 ID。

协议固定为 `openai_responses`，不做任意协议自动识别。部分第三方接口可能不支持 `/models`，所以模型 ID 是必填字段，模型列表发现只作为可选增强。

页面必须提示：Base URL 不是官方域名时，Key、Prompt、上下文和 Tool 输出都会发送给该第三方服务；用户应只使用信任且用途受限的凭据。

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

Tool Call 体检使用无副作用的 `mk_capability_probe`，禁止调用文件、网络、MCP 或其他真实 Tool。协议支持强制 Tool Choice 时才做确定性验证；不能强制时显示“未验证”，不能误判“不支持”。

能力状态在模型附近展示，不增加独立 Runtime 面板：

- 流式输出：支持 / 不支持 / 未验证。
- Tool Calling：支持 / 不支持 / 未验证。
- Token Usage：支持 / 不报告 / 未验证。
- 推理输出：支持 / 未发现 / 未验证。

模型可在 Tool Call 不支持时入园，但必须显示“仅聊天”，并在选择需要 Tools 的 Agent 时阻止误用或给出明确警告。

## 8. 协议 Adapter 边界

只维护三个协议 Adapter：

```text
OllamaNativeAdapter
ChatCompletionsAdapter
ResponsesApiAdapter
```

### 8.1 公共连接层

负责：

- SecretRef 解析和 Bearer 鉴权。
- Base URL、超时、有限重试和熔断。
- 错误体裁剪与 Secret 脱敏。
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

### 8.3 ResponsesApiAdapter

负责把 Responses 协议映射为现有 `ModelEvent`：

- output text delta → `text_delta`。
- reasoning/summary delta → `thinking_delta`。
- function call name/arguments 增量按 call id 聚合。
- function call output 回传。
- input/output/cached/reasoning usage 映射。
- response completed/failed/cancelled 终止语义。

Provider 上游使用 SSE 不改变产品边界：Browser 与 Remote 之间仍然只使用 ACP；Browser 不直接连接硅基流动、自定义 Base URL 或任何 Provider SSE。

## 9. Secret 与网络安全

- 真实功能中，Key 只从密码输入框提交给 Remote；Demo 不发请求，仅在当前 React 内存状态中短暂保留输入值。
- Key 不得进入 ModelStudent JSON、Session、Context Summary、Token 统计、Evaluation Trace、URL、日志、`localStorage` 或 `sessionStorage`。
- 持久层只保存 `credentialRef` 与脱敏尾号；保存后只能替换或删除，不能再次读取明文。
- 本地部署优先使用 macOS Keychain；远程部署使用受控 Secret Store。
- 预设的硅基流动 Base URL 不允许普通用户修改。
- 自定义云端 Base URL 必须是 HTTPS；Ollama 只对受控本机/私网连接类型允许 HTTP。
- Provider 原始错误可能包含 Header、URL 参数或请求片段，返回 Web 前必须脱敏。

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

## 11. Demo 边界

本轮 Demo：

- 只修改 `apps/web/src/demo/**` 和 Demo 路由。
- 所有检测由确定性定时状态模拟。
- 输入包含 `invalid` 时可进入失败演示。
- 成功后只保存不含 Key 的 Demo ModelStudent 与非敏感连接摘要，不保存或回显 Key 原文。
- 新生返回模型主页后自动选中，并出现在“我的 Models”。
- 不请求 Remote、Ollama 或硅基流动。
- 不创建第二个 ACP connection owner。
- 不修改真实 `apps/web/src/App.tsx`、ACP reducer、Runtime 或 Provider。

## 12. 真实开发分期

### Phase A：管理领域与 Secret

- ModelStudent Repository。
- ProviderConnection Repository。
- SecretStore write/replace/delete。
- 只返回 credential hint 的管理契约。

### Phase B：协议 Adapter

- 将现有 Ollama 单实例改为按 Connection resolve。
- 实现 ResponsesApiAdapter。
- 实现 ChatCompletionsAdapter，仅配置硅基流动 preset。
- 建立共享连接层和错误归一化。

### Phase C：入园与会话接线

- 连接测试、模型发现、模型体检。
- Session 保存 `modelStudentId`。
- Runtime 在 Prompt Turn 开始前解析确切 Provider。
- 我的 Models 支持替换 Key、重新检测、停用和删除。

### Phase D：验证与迁移

- Provider contract tests 和 SSE fixture tests。
- Tool Call 参数乱序聚合测试。
- Secret 泄漏扫描。
- 自定义 URL SSRF/重定向/DNS rebinding 测试。
- 旧环境变量 Ollama 配置迁移为默认 Connection 与 ModelStudent。

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
- Connection、模型发现、最小生成和 Tool Call 事实分别可观测。
- Tool Calling 不支持时不影响纯聊天入园，但不能伪装成 Agent 工具可用。
- 同一 Connection 可以新增多个 ModelStudent。
- 任何 Secret 不进入 Session、Context、Trace 或日志。

## 14. 官方依据

- Codex 自定义 Provider 的 `base_url`、OpenAI 鉴权与 `wire_api=responses`：<https://learn.chatgpt.com/docs/config-file/config-reference>
- SiliconFlow OpenAI Chat Completions 快速开始：<https://docs.siliconflow.cn/en/userguide/quickstart>
- SiliconFlow Function Calling：<https://docs.siliconflow.cn/en/userguide/guides/function-calling>
- SiliconFlow 模型目录：<https://docs.siliconflow.cn/en/api-reference/models/get-model-list>
- Ollama 本地模型目录：<https://docs.ollama.com/api/tags>
