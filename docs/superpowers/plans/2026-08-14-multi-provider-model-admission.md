# Multi-Provider Model Admission Implementation Plan

> 状态：设计确认，按本计划把现有 Responses 专用入园闭环重构为协议适配架构。页面验收暂停，直至用户明确恢复页面操作。

## 1. 目标

同一个“新模型入园”流程支持不同服务商，但不把不同协议伪装成只改 Base URL：

- OpenAI 官方：`openai_responses`
- 自定义 Responses 接口：`openai_responses`
- 硅基流动：`openai_chat_completions`
- Anthropic Claude：保留 `anthropic_messages` 扩展位，本期不显示为可用
- 本地 Ollama：保留 `ollama_native`，管理入园仍是独立后续项

页面只负责选择接入方式、收集该方式需要的字段、展示实际体检事实。协议请求、模型发现、能力体检和运行时序列化全部由 Remote 的 Adapter 完成。

## 2. 领域结构

```ts
type ProviderPresetId =
  | "openai"
  | "custom_responses"
  | "siliconflow"
  | "anthropic";

type ProviderProtocol =
  | "openai_responses"
  | "openai_chat_completions"
  | "anthropic_messages"
  | "ollama_native";

interface ProviderPreset {
  presetId: ProviderPresetId;
  protocol: ProviderProtocol;
  displayName: string;
  availability: "ready" | "planned";
  endpoint: { mode: "fixed" | "editable"; defaultBaseUrl?: string };
  auth: { scheme: "bearer" | "anthropic_api_key" | "none" };
  modelDiscovery: "remote_list" | "manual" | "remote_list_with_manual_fallback";
}

interface ProviderConnectionRecord {
  connectionId: string;
  ownerId: string;
  presetId: ProviderPresetId;
  protocol: ProviderProtocol;
  baseUrl: string;
  credentialRef: SecretRef;
  credentialHint: string;
}

interface ManagedModelStudentRecord {
  modelStudentId: string;
  connectionId: string;
  displayName: string;
  providerModelId: string;
  capabilitySnapshot: ProviderCapabilitySnapshot;
}
```

`ModelStudent` 不保存 Agent Prompt、Skills、MCP 或 Session 策略。API Key 只在一次体检请求的 Remote 内存和 Secret Store 中存在，公开合同只返回是否已配置及不可逆提示。

## 3. Adapter 边界

```ts
interface ProviderAdmissionAdapter {
  readonly protocol: ProviderProtocol;
  discoverModels?(candidate: ProviderCandidate): Promise<DiscoveredModel[]>;
  probe(candidate: ProviderCandidate): Promise<ProviderCapabilitySnapshot>;
  createProvider(connection: ProviderConnectionRecord, student: ManagedModelStudentRecord): ModelProvider;
}
```

Adapter Registry 以 `protocol` 解析 Adapter；Provider Preset 只提供产品预设，不实现协议。这样：

- OpenAI 官方与自定义 Responses 复用同一个 Responses Adapter；
- 硅基流动使用 Chat Completions Adapter；
- Claude 以后新增 Messages Adapter，不改入园状态机、Repository、Secret、Catalog、Session 或 ACP；
- 新增国内 OpenAI-compatible 服务时，优先新增 Preset，只有协议差异真实存在时才新增 Adapter。

## 4. 当前可用 Preset

| Preset | Base URL | 鉴权 | 模型发现 | 协议 |
|---|---|---|---|---|
| OpenAI 官方 | 固定为官方 API 根地址 | Bearer API Key | 手填 Model ID | Responses |
| 自定义 Responses | 用户填写公网 HTTPS 根地址 | Bearer API Key | 手填 Model ID | Responses |
| 硅基流动 | 固定为官方 API 根地址 | Bearer API Key | 手填 Model ID | Chat Completions |

三者当前都以手填 Model ID 入园。模型目录发现属于后续独立能力；只有对应 Adapter 真正实现 discovery API 后，Preset 才能把 `modelEntry` 从 `manual` 改为可发现。

固定 Preset 的 Base URL 由 Remote 决定，浏览器不能覆写。自定义地址必须经过 HTTPS、DNS/IP、重定向和实际连接地址一致性校验。

## 5. 能力体检

模型列表接口只用于发现 Model ID，不能声明 Tool 或推理能力。所有能力都以目标 `{presetId, baseUrl, modelId, credentialGeneration}` 的主动体检结果为准。

公共结果至少记录：

- 流式文本及正式终态；
- Tool Call 与 Tool Result 续轮；
- Input/Output Usage；
- 思考输出是否出现；
- Provider 原生推理控制参数与产品档位映射；
- `testedAt`、probe 版本和连接指纹。

Responses Adapter 探测 `reasoning.effort`，并只暴露目标接口实际接受且未被回显证据否定的档位。Chat Completions Adapter 分别探测服务真实支持的 `enable_thinking`、`thinking_budget` 或 `reasoning_effort`；不能因模型名称或服务商品牌直接写死。一次探测没有出现缓存或推理 Token 时保持“未验证”，不伪造成 0 或不支持。

## 6. 页面状态机

```text
选择接入方式
  -> 填写连接
  -> 读取或填写 Model ID
  -> 体检目标模型
  -> 查看能力事实
  -> 确认入园
```

- 切换 Preset、Base URL、API Key 或 Model ID：立即丢弃旧体检；
- 修改模型学生昵称：保留体检；
- OpenAI 官方和硅基流动隐藏 Base URL，仅显示服务商、Key 和 Model；
- 自定义 Responses 才显示 Base URL；
- 页面不出现特定客户端、配置文件或某次代理地址的反例文案；
- 未实现的 Adapter 不显示成可选择项。

## 7. Control API

- `GET /model-provider-presets`：Remote 返回当前真正可用的 Preset 和字段描述；Web 不维护第二份支持列表。
- `POST /model-student-tests`：提交带 `presetId` 的判别联合 Candidate；Secret 不落盘。
- `GET /model-student-tests/:testId`：读取脱敏体检结果。
- `POST /model-students`：消费成功且未过期的 `testId`，原子保存 Connection、Secret 与 ModelStudent。
- `GET /model-students`：返回可选择的 ModelStudent；不返回 SecretRef。

## 8. 实施顺序

- [ ] 将 Responses 专用合同改为 Provider-neutral 判别联合，同时为现有记录提供明确迁移读取。
- [ ] 新增 ProviderPreset Registry，并由 Control API 暴露真正可用项。
- [ ] 将 ModelAdmissionService 改为按 protocol 调 Adapter Registry；Repository 保存 presetId/protocol。
- [ ] 把 OpenAI 官方作为固定地址的 Responses Preset 接入现有 Adapter/Probe。
- [ ] 实现 SiliconFlow Chat Completions Adapter、真实 Probe、运行时 Tool/Usage/Reasoning 映射。
- [ ] 将正式入园页改成 Preset 驱动字段，不在 React 中硬编码协议能力。
- [ ] 更新 ModelStudent Catalog、Session/ACP 动态能力测试。
- [ ] 更新长期文档的已实现/未实现边界；Claude 只记录扩展合同，不展示为可用。
- [ ] 在不操作用户页面的前提下完成 contract、mock endpoint、Remote、Web、全仓构建验证。
- [ ] 用户明确恢复页面操作后，再进行真实 API 的输入、体检、入园和档位切换验收。

## 9. 非写死验收

1. 相同 Model ID、不同 Responses mock endpoint 返回不同 effort 接受集合，页面与 Runtime 必须显示不同档位。
2. 非 OpenAI 命名的 Model ID 若真实接受 `xhigh`，仍能得到 `max -> xhigh`。
3. OpenAI 官方与自定义 Responses 复用同一 Adapter，但 Base URL 策略不同。
4. SiliconFlow mock 只接受开关时，只呈现开关语义；支持预算或 effort 时按实测能力呈现，不能套用 Responses 四档。
5. 换 Key、地址、协议或 Model ID 后，旧 snapshot 立即失效。
6. Session 绑定哪个 ModelStudent，ACP 就只返回该学生体检确认的选项；实际 Provider 请求包含冻结后的原生参数。
7. Claude Adapter 未来加入时，不修改入园状态机、Repository schema 的公共部分或 Session/ACP 主链。
