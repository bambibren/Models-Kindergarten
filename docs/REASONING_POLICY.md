# Model Reasoning Policy

> 状态：Agent 与模型推理配置已分离；ModelStudent 默认、ACP Session 覆盖、Turn 快照与受管 Provider 映射沿用唯一真实主链。
> 更新：2026-08-15
> 适用：ModelStudent 入园、Agent 编辑、ACP Session、AgentRuntime、Provider Adapter、Context/Token 可视化和 Evaluation。

## 1. 决策摘要

推理强度不是一条直接发送给 Provider 的 UI 字符串。Models Kindergarten 在三个执行生命周期层分别保存不同事实；Agent 不参与模型推理参数解析：

```text
ModelStudent capability + generationDefaults.reasoningProfile
              ↓
Session override（当前会话是否覆盖）
              ↓ Turn 开始时解析一次
ResolvedReasoningSnapshot（本 Turn 实际发送了什么）
              ↓
Provider native request
```

有效值的优先级固定为：

```text
Session override > ModelStudent default
```

产品层只使用 `auto | fast | balanced | deep | max`。`auto` 只表示 Session 没有覆盖；`xhigh`、`reasoning.effort`、`think` 等 Provider 原生概念只能出现在 Model capability、Provider Adapter 和不可变 Turn 快照中，不能泄漏为 Agent 或 Session 的领域字段。

## 2. 四层所有权

| 层 | 字段 | 生命周期 | 是否可变 | 含义 |
|---|---|---|---|---|
| ModelStudent | `reasoningCapability` / `generationDefaults` | 模型入园与模型配置 | 重新体检或用户修改模型默认时更新 | 经体检的控制方式和原生参数范围，以及用户选择的 `reasoningProfile` 与模型温度默认值 |
| Agent | `systemPrompt` / Skills / MCP / Tool 约束 | Agent 配置 | 用户编辑 Agent 时更新 | 上下文与能力策略；不保存推理强度、温度或其他模型执行参数 |
| Session | `reasoningOverride?` | 当前 Session | 空闲时设置或清除 | 唯一允许覆盖的模型执行配置；缺失表示跟随 ModelStudent 默认档位 |
| Turn | `resolvedReasoning` | 单次 Prompt Turn | 开始后不可变 | 解析后的产品档位、来源、模型身份和实际 Provider 参数 |

这套设计不引入 AgentVersion 或 AgentRevision。Agent 是一个可编辑对象；Session 继续只绑定 `agentId + modelStudentId`。Agent 独占 `systemPrompt`，ModelStudent 的 `generationDefaults` 拥有 `temperature`；Session 不能覆盖温度。为了可复现，Turn 另外保存开始执行时读取到的 Agent snapshot、capability snapshot 和 reasoning snapshot。

## 3. 产品语义与数据结构

```ts
type ReasoningProfile =
  | "auto"
  | "fast"
  | "balanced"
  | "deep"
  | "max";

type ConcreteReasoningProfile = Exclude<ReasoningProfile, "auto">;

type ReasoningControl =
  | "fixed"
  | "toggle"
  | "effort_levels"
  | "token_budget";

interface ModelReasoningCapability {
  schemaVersion: 1;
  control: ReasoningControl;
  adjustable: boolean;
  supportedProfiles: ConcreteReasoningProfile[];
  defaultProfile: ConcreteReasoningProfile;
  native?: {
    parameter: string;
    values?: Array<string | number | boolean>;
    minBudget?: number;
    maxBudget?: number;
  };
}

interface ModelGenerationDefaults {
  reasoningProfile: ConcreteReasoningProfile;
  temperature?: number;
}

interface ResolvedReasoningSnapshot {
  schemaVersion: 1;
  requestedProfile: ReasoningProfile;
  resolvedProfile: ConcreteReasoningProfile;
  source: "session_override" | "model_default";
  providerKind: string;
  model: string;
  native: Record<string, string | number | boolean>;
}
```

### 3.1 Model capability 不变量

- `supportedProfiles` 只包含具体档位，不能包含 `auto`。
- capability 中的 `defaultProfile` 是体检记录的 Provider 原始默认事实，必须属于 `supportedProfiles`；它不等于用户随后选择的模型默认值。
- `ModelStudent.generationDefaults.reasoningProfile` 是用户选择的有效模型默认值，也必须属于同一 `supportedProfiles`。
- `fixed` 只能声明一个具体档位，`adjustable=false`。
- `adjustable` 必须与“是否有多个具体档位”一致。
- `native.parameter` 只是能力披露；真实请求仍由对应 Provider Adapter 的映射函数构造。
- 自定义模型的能力来自入园体检和持久化结果，不能根据模型名称猜测。

### 3.2 `auto` 的精确定义

`auto` 只在 Session 配置入口表达“不要覆盖 ModelStudent 默认值”，不作为 ModelStudent 能力或 Session 持久化值：

- ModelStudent 在 `generationDefaults.reasoningProfile` 中保存用户从已体检 `supportedProfiles` 中选择的具体默认档位；capability 的 `defaultProfile` 继续保留体检事实。
- Session 选择“跟随模型默认 · {档位}”：向 ACP 发送值 `auto`，Remote 删除 `reasoningOverride`。
- Session Repository 只保存具体档位；没有字段就是跟随 ModelStudent 默认档位。
- Turn 永远保存一个具体的 `resolvedProfile` 和 Provider 原生 `native`。

因此，“跟随模型默认 · 均衡”这类文案中的“均衡”来自当前 ModelStudent 的 `generationDefaults.reasoningProfile`；它不是某种 Provider 自动模式，也不会把字符串 `auto` 原样发送给模型。

## 4. Turn 解析与冻结

解析只允许发生在 `AgentRuntime.run` 的 Turn 边界：

```ts
requested = session.reasoningOverride
  ?? model.generationDefaults.reasoningProfile;
source = session.reasoningOverride
  ? "session_override"
  : "model_default";

resolved = assertSupported(
  requested,
  model.reasoningCapability.supportedProfiles,
);
native = provider.nativeReasoning(resolved);
```

`generationDefaults.reasoningProfile` 必须属于该 ModelStudent 经体检确认的 `supportedProfiles`，Session UI 也只提供同一集合中的具体档位。两种输入都不需要做“就近降档”；发现不一致时应拒绝执行并要求重新体检或修正持久化数据，不能静默改变用户选择。

冻结后，同一 Turn 的所有模型轮次复用同一 `ResolvedReasoningSnapshot`。Turn 中安装 Skill、刷新 Tool capability、编辑 Agent 或修改后续 Session 配置，都不能改变当前快照。ACP Adapter 在 Prompt 活动期间拒绝 `session/set_config_option`，防止 UI 呈现与正在执行的 Turn 不一致。

Turn 事实保存：

- `TurnExecutionRecord.resolvedReasoning`：本 Turn 的统一执行事实；
- `modelRounds[].resolvedReasoning`：每次实际模型请求的对应事实；
- `modelRounds[].providerInput`：由 Provider 与真实请求共用转换函数生成的脱敏原文；
- `agentSnapshot`：只保存当次使用的 Agent 上下文与能力策略，不包含推理默认值。

终态写入必须包含以上事实。为保证进程中断后仍可审计，Runtime 在解析完成后立即 checkpoint `active` Turn，并在每个模型轮次开始和完成时增量保存 round facts；最终从 `finalizing` 原子提交输出与互斥终态。

## 5. Provider 映射

### 5.1 Ollama / qwen3:8b

启动入口始终创建内置 Ollama Provider，并可从受管 Catalog 恢复已入园的 Responses Provider：

| 产品档位 | Provider 请求 |
|---|---|
| `fast` | `think: false` |
| `balanced` | `think: true` |

它声明 `supportedProfiles=[fast, balanced]`，capability 继续记录体检得到的 `defaultProfile`；新入园或内置初始化时由 ModelStudent 在 `generationDefaults.reasoningProfile` 保存用户有效默认值。有效默认值为 `balanced` 时，Composer 展示“跟随模型默认 · 均衡”、快速和均衡，不能展示 `deep` 或 `max`。

### 5.2 OpenAI-compatible Responses

产品档位使用下列协议级候选映射进行端点体检；只有目标端点正式接受的项才会进入该 ModelStudent 的能力快照：

| 产品档位 | `reasoning.effort` |
|---|---|
| `fast` | `low` |
| `balanced` | `medium` |
| `deep` | `high` |
| `max` | `xhigh` |

请求同时发送 `reasoning.summary="auto"`。启用非 `none` 推理时不发送可能不兼容的 `temperature`；内部结构化任务显式使用 `reasoning="disabled"` 时，Adapter 发送 `reasoning.effort="none"`、不发送 summary，并允许保留 temperature。Provider 在发送前校验 Turn snapshot 的 `providerKind + model` 与当前 ModelStudent 一致，避免将另一模型的原生参数误用到当前请求。

Responses 只接受 `response.completed`、`response.incomplete` 或 `response.cancelled` 作为正式终态，传输层 `[DONE]` 不能替代协议终态。Runtime 收到 cancelled 后立即结束 Turn，并丢弃已聚合但尚未执行的 Tool Call，避免取消请求仍产生副作用。

未知自定义 Responses 模型没有名称猜测回退。模型入园必须提供经体检确认的 `ModelReasoningCapability + profile-to-effort mapping`；任何支持集合、默认值和原生枚举不一致都应拒绝保存。

Responses Adapter 已接入 `apps/remote/src/index.ts`、`ModelStudentCatalog` 和 Session resolver。每一条自定义 Connection 都必须通过相同的真实端点体检；本地 fixture、模型名称和其他 Connection 的结果都不能作为该连接的能力来源。第 10 节的无状态 Tool loop 已在 Adapter/Runtime/Session 边界闭环。

### 5.3 Token budget 型模型

契约允许 `control="token_budget"` 和原生 min/max 能力描述，但当前没有 Provider Adapter 将五档映射为预算数值。UI 不得仅凭这个契约宣称某个 token-budget 模型已经兼容。

## 6. ACP SessionConfigOption

Remote 通过官方 ACP Session 配置承载会话覆盖，不把设置塞进用户 Prompt、浏览器 localStorage 或私有 WebSocket 消息：

```ts
{
  type: "select",
  id: "reasoning_profile",
  category: "thought_level",
  currentValue: "auto" | ConcreteReasoningProfile,
  options: [
    { value: "auto", name: "跟随模型默认 · 均衡" },
    // 仅当前 ModelStudent 支持的具体档位
  ]
}
```

- `session/new`、`session/load`、`session/resume` 返回完整 `configOptions`。
- 固定模型或不可调模型不返回该选项。
- Browser 在 initialize 时声明 Session config option 能力。
- 选择具体值会持久化到 Session；选择 `auto` 会清除覆盖。
- 正在执行 Prompt 时拒绝修改；非法 ID、非法产品值和模型不支持的值都返回协议错误。
- 同一 Session 的“检查空闲并更新配置”与“预占 Prompt 并读取 Session”必须进入同一个串行临界区；不能依赖 Browser 禁用状态消除并发请求竞态。
- 页面刷新或换 WebSocket 后，以 Remote 返回的 Session 配置为准。

### 6.1 首轮设置顺序

首页 Composer 的选择属于待创建 Session，而不是某条消息。用户发送后顺序固定为：

```text
创建 SessionLaunchDraft
  → ACP session/new
  → 若有具体覆盖，调用 session/set_config_option
  → 等待成功响应
  → ACP session/prompt
```

`SessionLaunchDraft.reasoningProfileOverride` 只允许具体档位；“跟随模型默认 · {档位}”不写字段。这样第一条 Prompt 开始前，Remote 已经拥有正确的 Session override，不存在首轮使用旧配置的竞态。

## 7. UI 规则

- Agent 编辑页不显示或保存推理强度；Agent 只编辑上下文与能力策略。
- ModelStudent 入园在体检成功后，只允许从该模型真实支持的档位中选择 `generationDefaults.reasoningProfile`；capability 的原始 `defaultProfile` 不因用户选择而改写。
- Session Composer 的选择持续作用于当前 Session，不是“本消息设置”。
- `auto` 的文案动态显示为“跟随模型默认 · {档位}”，例如“跟随模型默认 · 均衡”；具体项显示“快速 / 均衡 / 深入 / 极致”，不向普通用户暴露 `xhigh`、布尔 `think` 或预算数值。
- 固定模型隐藏 Session 控件；可调模型只列出能力中实际支持的值。
- Prompt Turn 状态为 active 或配置请求在途时禁用控件。
- ACP 是 Session 当前值的事实源；ModelStudent capability 只用于产品标签和防御性过滤。
- Session 唯一可以覆盖的模型执行配置是推理强度；`temperature` 始终来自 ModelStudent，不能在 Session 或 Turn UI 中改写。
- 原生配置与完整 Provider 输入出现在上下文/执行披露附近，不增加另一套 Runtime 可视化页面。

### 7.1 Context Experiment 本轮边界

Context Experiment 的 Agent/策略输入只删除推理强度字段，使所有 lane 统一走“Session override → ModelStudent default”。本轮不调整实验 source-of-truth、History、preview serializer、评分、worksheet 或实验快照流程；这些问题留给后续系统性重构。

## 8. 持久化与迁移

### 8.1 Agent

Agent 合同和持久化记录删除 `defaultReasoningProfile`。已有 Agent 记录中的该字段属于废弃配置，只在一次性数据清理中移除，不能继续参与 Runtime 解析。`systemPrompt` 只能来自 Agent；Runtime 不从 ModelStudent 读取或兜底 Agent 系统提示。

### 8.2 Session

Session 只保留可选的具体 `reasoningOverride`；字段缺失表示跟随 ModelStudent 默认值。历史聊天 Session 与 Turn 文件先完整归档，再从活跃 Repository 清空；新实现不提供旧 Session schema 或旧 reasoning source 的读取兼容。

### 8.3 Turn

新 Turn 必须保存完整 `resolvedReasoning`，其 `source` 只允许 `session_override | model_default`，Agent snapshot 不含推理字段。带有 `agent_default` 或缺少新必需执行事实的旧 Turn 只存在于归档中，不能重新导入活跃 Repository，也不能根据今天的 Agent、模型能力或 Provider 映射反推。

## 9. 安全、可观测与 Token 边界

### 9.1 安全

- 推理档位不是 Secret，但 Provider request snapshot 仍不得包含 API Key、Authorization header 或可回读的 credentialRef 明文。
- Browser 不直接连接 Provider；自定义 Base URL、Key、Prompt、Tool 输出只由 Remote 处理。
- Session Config 的值必须经过共享产品枚举、当前模型 supported profiles 和 active-Turn 三重校验。
- `native` 只来自受信 Provider Adapter 或经模型入园验证的映射，不能接受浏览器直接提交任意 JSON。
- Responses 的完整 `response.output` 只保存为 Remote 内部 `provider_continuation` Session 事实。公开 Repository 读取会剥离该记录，ACP history replay 会跳过它；Context Summary、`serializeContext`、`serializeInput`、Runtime Observation 和 Evaluation 只能看到 `providerOpaque`、item 类型、数量或字节数等脱敏占位。
- `encrypted_content` 是 Provider 返回的 opaque 密文，不等于整个 Session 已做应用层加密；当前 Session 文件仍依赖 `0600` 文件权限。它不得进入日志、错误文案、聊天 Thought 或面向用户的原文展示。

### 9.2 可观测

执行披露应同时回答：

1. Session 是否请求了具体覆盖；没有覆盖时，ModelStudent 默认档位是什么；
2. 最终解析成哪个产品档位，来源是哪一层；
3. 哪个 Provider/模型收到哪些原生参数；
4. 每轮模型请求实际序列化的原文是什么。

不要在执行披露中记录或推导 Agent 默认值；也不要只记录 `xhigh`，因为它无法表达用户选择和跨 Provider 语义。

当前 `/turns/:turnId/context` 通过 Session Turn facts 提供 resolved reasoning、每轮 provider input 和完整 usage。`RuntimeObservationEvent → Evaluation 模块` 也保存 Turn/round 的 resolved reasoning，并投影 cached input 与 reasoning output 明细；两条观察链共享同形快照，但 Evaluation 合同不反向依赖领域包。

### 9.3 Token

推理策略和 Token 统计是两个独立事实。Provider 报告的顶层总量按以下关系解释：

- `inputTokens` 与 `outputTokens` 是互斥的顶层总量；
- `cachedInputTokens` 是 `inputTokens` 的子集，不能再加一次；
- `reasoningOutputTokens` 是 `outputTokens` 的子集，不能再加一次；
- Provider 未报告的细项保持 `undefined`，不能用 `0` 冒充已确认无消耗；
- 一个 Turn 含多个模型轮次时，对每轮 Provider usage 求和；聊天气泡旁的组件估算不能代替 Provider 总量。

## 10. 自定义 Responses 入园与 Tool loop 门禁

自定义 Responses 模型在保存为 ready 前，至少要分别验证：

1. Bearer 鉴权和 `POST {baseUrl}/responses`；
2. 文本增量、reasoning/summary 增量和正常终止事件；
3. 多个并行 function call 的 item index、item ID、call ID、参数增量与完成聚合；
4. function call output 回传后的下一模型轮次；
5. input/output/cached/reasoning usage 映射；
6. failed/cancelled/incomplete 等终态；
7. 支持的 effort 集合、默认 effort 和采样参数兼容性；
8. `store:false` / ZDR 下完整 opaque reasoning continuation。

第 8 项不能用可见 reasoning summary 代替。当前 Responses 协议链已经从响应中保留下一轮所需的完整 opaque output items（包括上游要求的 encrypted continuation），经 Runtime 原样关联到同一轮 assistant/tool 上下文，再与 `function_call_output` 一起发送。完成的 Turn 另存一条不参与聊天投影的 `provider_continuation` Session 事实；下一 Turn 由 `ContextAssembler` 用它替换重复的可见 assistant/function-call 投影，同时保留并紧随对应 Tool Result。该数据只能作为 Provider 私有续传状态：

- 不投影为聊天 Thought；
- 不展示为用户可读推理原文；
- 不跨 Provider 或模型复用；
- 不进入产品级 reasoning profile；
- 不进入公开 Session API、ACP replay、Context 原文披露或 Evaluation Trace；
- 只有实际 Provider request 构造读取完整 items，披露序列化只能输出脱敏占位；
- 必须有本地 HTTP/SSE Tool loop 测试证明第二个请求包含所需原始 item 和对应 `function_call_output`，且落盘重载后的下一 Turn 顺序不变。

当前本地合约测试已经覆盖并行 Tool Call、完整 continuation、跨 Turn 落盘恢复、跨模型拒绝，以及所有公开披露面不含加密 sentinel。这里证明的是 MK 协议实现，不是任意自定义服务端的兼容性。每条自定义 Responses Connection 仍须在入园时跑同等 capability probe；在接入受管 Connection、SecretStore、Provider resolver 之前，Responses Adapter 不得出现在真实 ModelStudent 选择列表。硅基流动 Chat Completions 也不因共享 `ModelProvider` 接口而自动获得兼容声明。

Turn 的 reasoning、capability 和 model-round execution facts 会在运行中 checkpoint。聊天流条目、Tool Result 和 `provider_continuation` 仍遵循现有 Turn 结束时的原子批量提交；当前不承诺进程在 Tool loop 中途崩溃后恢复并继续同一 Prompt。

## 11. 当前实施边界

### 已进入真实主链

- 共享产品 profile、Model capability 和 Turn snapshot 契约及校验；
- Agent 推理字段的删除，以及 ModelStudent 用户默认值的读取；
- Session V4 具体覆盖值的持久化与 ACP `thought_level` 设置；
- 首轮创建后、Prompt 前设置覆盖的 Web 流程；
- Turn 边界解析、Provider 原生映射、running checkpoint 和终态 execution facts；
- Evaluation Trace 的 Turn/round reasoning snapshot 与 cached/reasoning usage；
- Ollama `fast/balanced` 映射；
- ModelStudent 入园默认值、首页和 Session Composer 控件；Agent 编辑页不再提供推理控件；
- Responses effort/summary、SSE 增量、usage 和终态的 Adapter 核心；
- Responses `store:false` 完整 output-item continuation：同 Turn Tool loop、隐藏 Session 持久化、跨 Turn 恢复、公开披露脱敏和跨模型拒绝。

### 尚未对用户开放或仍是门禁

- 真实 ModelStudent 入园、ProviderConnection 和 SecretStore 管理页面；
- 硅基流动 Chat Completions Adapter；
- Responses Provider 在进程启动入口、Catalog 和 Session provider resolver 中的接线；
- 自定义 Responses capability probe 与映射持久化；
- token-budget Provider 的实际映射；
- 生产级 SecretStore、SSRF/重定向策略和真实自定义 endpoint 的兼容体检。

## 12. 验收标准

- 同一输入下，Session override 始终覆盖 ModelStudent 默认；清除后立即恢复“跟随模型默认 · {档位}”。
- ModelStudent 的 `generationDefaults.reasoningProfile` 必须来自本模型经体检确认的支持集合，不做名称猜测或静默降档；capability 的原始 `defaultProfile` 保留为体检事实。
- Prompt 活动中不能修改 Session 设置，修改后只影响后续 Turn。
- 新 Session 的首轮 Prompt 使用首页选择的覆盖值。
- 每个新 Turn 和模型轮次都能查看产品值、来源、模型身份和实际原生参数。
- Ollama 请求只产生与 `fast/balanced` 对应的布尔 `think`。
- Responses `max` 产生经体检确认的原生值；已验证 preset 为 `xhigh`，且不携带不兼容 temperature。
- 未体检的自定义模型、非法原生映射、跨模型 snapshot 和未知 ACP 值都被拒绝。
- Responses Tool loop 的第二次实际请求包含完整 opaque output items 和对应 Tool Result，既不重复 function call，也不把 opaque 原文暴露到公开 Session、ACP、Context disclosure 或 Evaluation。
- cached/reasoning Token 仅作为 input/output 子项展示，不重复计入总量。
- 历史 Session/Turn 完整归档后从活跃 Repository 清空；旧 Turn 不兼容、不回灌，Agent、ModelStudent、Skills、MCP 与 Secret 配置不在清空范围内。

相关文档：[ModelStudent 入园设计](MODEL_ADMISSION.md) · [D2P-1 架构](ARCHITECTURE.md) · [ACP 兼容说明](ACP_COMPAT.md)
