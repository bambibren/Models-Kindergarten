# Models-Kindergarten Control API 与 ACP 接口文档

> 文档基线：当前工作树，Git `377f2939104e`，整理日期 2026-09-08。
> 本文描述当前 Remote 实际注册的接口，不把 SDK 支持但项目未注册的能力写成已实现能力。字段名、路径、HTTP 方法、枚举值和类型名保留源码原文，其余说明均使用中文。

## 1. 接口边界

```text
浏览器 Web
├─ 管理面与只读查询
│  └─ HTTP /api/control/v1/*
│     └─ ControlApi → 各领域 Service → Repository / Runtime 依赖
│
└─ 实时 Agent 会话
   └─ WebSocket /acp
      └─ ACP JSON-RPC → KindergartenAgent → AgentRuntime
         ├─ Agent → Client：session/update 与项目扩展通知
         └─ Agent → Client：权限请求、结构化提问
```

- `Control API` 是 HTTP 控制面适配层；除匿名接口外，按登录账号校验资源归属。
- `ACP` 是 WebSocket 上的官方 Agent Client Protocol；负责 Session 生命周期、Prompt、流式输出、取消和双向用户交互。
- 两者共用同一个 Remote HTTP Server 和端口，但路由和处理模块不同。
- `/health`、`/health/live`、`/health/ready` 属于服务器健康检查，不属于 `/api/control/v1`，因此不计入下文 76 条 Control API 路由。

## 2. Control API 通用约定

### 2.1 基础地址与认证

| 项目 | 约定 |
|---|---|
| 基础路径 | `/api/control/v1` |
| 默认内容类型 | 写请求使用 `application/json`；JSON 响应使用 `application/json; charset=utf-8` |
| 认证方式 | `mk_session` Cookie；开发模式使用本地身份 `local-admin` |
| 匿名接口 | `/auth/login`、`/auth/session`、`/auth/logout`、`/public/artifacts/*`、带签名 `token` 的 `/onlyoffice/artifacts/:artifactId/raw` |
| 同源保护 | 写请求的 `Origin` 必须在服务端允许列表中 |
| 请求体上限 | 默认 256 KiB；按字节边读边限制 |
| 并发保护 | 超过 Control API Handler 并发上限返回 `503 REMOTE_BUSY` |
| CORS 预检 | `OPTIONS` 成功返回 204；允许请求头 `content-type,idempotency-key` |
| 追踪头 | 所有 Control API 响应包含 `x-request-id` |

### 2.2 JSON 成功响应

除认证接口和二进制接口外，成功结果统一包装为 `ApiSuccess<T>`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `data` | `T` | 是 | 路由 Handler 的业务返回值；无返回值时为 `null` |
| `requestId` | `string` | 是 | 本次请求的服务端追踪 ID |

- `POST` 默认状态码为 201；其他方法默认 200。
- 认证接口自行返回 200，成功体为 `{ data: ... }`，不包含 `requestId`，但响应头仍有 `x-request-id`。
- 二进制接口直接返回文件流，不使用 `ApiSuccess<T>` 包装。

### 2.3 错误响应 `ApiProblem`

内容类型为 `application/problem+json; charset=utf-8`。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `type` | `string` | 是 | Problem 类型 URI；当前通常为 `about:blank` |
| `title` | `string` | 是 | 错误标题，通常与 `code` 对应 |
| `status` | `number` | 是 | HTTP 状态码 |
| `detail` | `string` | 是 | 面向调用方的中文错误详情 |
| `code` | `PublicErrorCode` | 是 | 稳定业务错误码 |
| `requestId` | `string` | 是 | 请求追踪 ID |
| `retryable` | `boolean` | 是 | 调用方是否适合稍后重试 |
| `fieldErrors` | `{ path:string; message:string }[]` | 否 | 字段级校验错误 |

`PublicErrorCode` 当前枚举：`VALIDATION_FAILED`、`NOT_FOUND`、`CONFLICT`、`IDEMPOTENCY_CONFLICT`、`ORIGIN_NOT_ALLOWED`、`AUTHENTICATION_REQUIRED`、`SESSION_BINDING_INVALID`、`SESSION_BUSY`、`REMOTE_BUSY`、`CAPABILITY_REFERENCE_INVALID`、`CAPABILITY_STALE`、`SKILL_SOURCE_NOT_ALLOWED`、`SKILL_SOURCE_NOT_USER_PROVIDED`、`SKILL_SOURCE_URL_LIMIT_EXCEEDED`、`SKILL_SOURCE_NAME_CONFLICT`、`SKILL_VALIDATION_FAILED`、`SKILL_JOB_INTERRUPTED`、`MCP_URL_NOT_ALLOWED`、`MCP_AUTH_NOT_SUPPORTED`、`MCP_TEST_EXPIRED`、`MCP_CONNECTION_FAILED`、`MCP_NOT_AVAILABLE`、`MODEL_URL_NOT_ALLOWED`、`MODEL_CONNECTION_FAILED`、`MODEL_PROBE_EXPIRED`、`MODEL_IN_USE`、`EXPERIMENT_NOT_RUNNABLE`、`EXPERIMENT_READ_ONLY`、`EXPERIMENT_PREVIEW_UNAVAILABLE`、`EXPERIMENT_NO_EFFECTIVE_DIFFERENCE`、`EXPERIMENT_SOURCE_CHANGED`、`LEGACY_EXPERIMENT_READ_ONLY`、`EXECUTION_METRICS_UNAVAILABLE`、`SCORECARD_INCOMPLETE`、`WORKSHEET_NOT_READY`、`WORKSHEET_GENERATOR_UNAVAILABLE`、`WORKSHEET_GENERATION_FAILED`、`WORKSHEET_GENERATION_INVALID`、`TURN_SNAPSHOT_UNAVAILABLE`、`FILE_REFERENCE_FORBIDDEN`、`FILE_PREVIEW_NOT_SUPPORTED`、`ARTIFACT_FORBIDDEN`、`ARTIFACT_VALIDATION_FAILED`、`ARTIFACT_RESOURCE_LIMIT`、`ARTIFACT_RESOURCE_NOT_FOUND`、`ARTIFACT_BLOB_CORRUPT`、`INTERNAL_ERROR`。

## 3. Control API 路由总表

下表中的响应类型均指 `ApiSuccess<响应类型>`，认证和二进制接口除外。当前启动组合传入了所有可选 Service，因此 76 条路由均会注册；源码中标记为“条件”的路由，在依赖未注入的其他组合中不会注册。

除表内明确标注“匿名”或“签名票据”的接口外，以下每一条路由都要求 `mk_session` 登录认证；各表省略重复的“认证”列。每条路由都可能返回 2.3 节的 `ApiProblem`，其中 `AUTHENTICATION_REQUIRED`、`ORIGIN_NOT_ALLOWED`、`VALIDATION_FAILED`、`REMOTE_BUSY`、`INTERNAL_ERROR` 是跨路由公共错误；业务相关错误按 3.11 节索引。只读请求不执行 `Origin` 写请求校验。

### 3.1 认证

| 方法与路径 | 认证 | 请求 | 成功响应 | 用途 |
|---|---|---|---|---|
| `POST /auth/login` | 匿名 | `LoginInput` | `{ authenticated:true; principal:PublicPrincipal }`，200 | 登录并设置 `mk_session` Cookie |
| `GET /auth/session` | 匿名 | 无 | `{ authenticated:true; principal:PublicPrincipal }`，200 | 解析当前 Cookie 会话 |
| `POST /auth/logout` | 匿名 | 无 | `{ authenticated:false }`，200 | 注销并清除 Cookie |

### 3.2 Agent

| 方法与路径 | 参数 | 请求体 | 成功响应 | 用途 |
|---|---|---|---|---|
| `GET /agents` | 查询：`query?:string`、`cursor?:string`、`limit?:integer`，`limit` 实际收敛到 1～100，默认 20 | 无 | `CursorPage<AgentRecord>` | 分页检索当前账号 Agent |
| `POST /agents` | 无 | `AgentInput` | `AgentRecord` | 创建 Agent |
| `GET /agents/:agentId` | 路径：`agentId:string` | 无 | `AgentRecord` | 查询 Agent |
| `PUT /agents/:agentId` | 路径：`agentId:string` | `AgentInput` | `AgentRecord` | 整体更新 Agent |
| `DELETE /agents/:agentId` | 路径：`agentId:string` | 无 | `null` | 删除可删除 Agent |
| `GET /capability-options` | 无 | 无 | `CapabilityOptions` | 读取 Agent 编辑器可绑定能力 |

### 3.3 Session 与 Turn

| 方法与路径 | 参数 | 请求体 | 成功响应 | 用途 |
|---|---|---|---|---|
| `POST /session-launches` | 无 | `SessionLaunchInput` | `SessionLaunchDraft` | 创建短时会话启动草稿；条件注册 |
| `GET /session-launches/:launchId` | 路径：`launchId:string` | 无 | `SessionLaunchDraft` | 读取未过期启动草稿；条件注册 |
| `GET /sessions` | 查询：`purpose?:"chat"|"experiment"`，其他值按 `chat`；`query?:string` | 无 | `{ items:SessionSummary[] }` | 查询当前账号 Session |
| `GET /sessions/:sessionId` | 路径：`sessionId:string` | 无 | `SessionSummary` | 查询 Session 摘要 |
| `GET /sessions/:sessionId/turns` | 路径：`sessionId:string`；查询：`limit?:integer`、`beforeTurnId?:string` | 无 | `SessionTurnPage` | 倒序游标分页读取 Turn 和聊天条目 |
| `GET /turns/:turnId` | 路径：`turnId:string` | 无 | `TurnView` | 查询完整 Turn 执行记录 |
| `GET /turns/:turnId/context` | 路径：`turnId:string` | 无 | `TurnContextView` | 查询冻结策略、能力快照和模型轮次证据 |

### 3.4 Skill

| 方法与路径 | 参数 | 请求体 | 成功响应 | 用途 |
|---|---|---|---|---|
| `GET /skills` | 查询：`state?:SkillInstallationState`、`query?:string` | 无 | `{ items:SkillInstallation[] }` | 查询当前账号 Skill 安装记录 |
| `GET /skills/:skillInstallationId` | 路径：`skillInstallationId:string` | 无 | `SkillInstallation` | 查询 Skill 安装详情 |
| `DELETE /skills/:skillInstallationId` | 路径：`skillInstallationId:string` | 无 | `{ removedAgentBindings:string[] }` | 卸载并清理 Agent 绑定 |
| `POST /skill-install-jobs` | 无 | `SkillInstallJobInput` | `SkillInstallJob` | 创建人工安装 Job |
| `GET /skill-install-jobs/:jobId` | 路径：`jobId:string` | 无 | `SkillInstallJob` | 查询安装 Job |
| `POST /skill-install-jobs/:jobId/retry` | 路径：`jobId:string` | 无 | `SkillInstallJob` | 重试失败或中断 Job |

### 3.5 MCP

| 方法与路径 | 参数 | 请求体 | 成功响应 | 用途 |
|---|---|---|---|---|
| `POST /mcp-tests` | 无 | `McpCandidateInput` | `McpTestRecord` | 连接候选 MCP 并探测能力 |
| `GET /mcp-tests/:testId` | 路径：`testId:string` | 无 | `McpTestRecord` | 查询测试结果；过期成功记录投影为 `expired` |
| `GET /mcps` | 无 | 无 | `McpInstallationView[]` | 查询当前账号 MCP 安装 |
| `POST /mcps` | 无 | `McpInstallInput` | `McpInstallationView` | 从成功且未过期的测试安装 MCP |
| `GET /mcps/:mcpId` | 路径：`mcpId:string` | 无 | `McpInstallationView` | 查询 MCP 安装 |
| `POST /mcps/:mcpId/reconnect` | 路径：`mcpId:string` | 无 | `McpInstallationView` | 重连并刷新能力快照 |
| `POST /mcps/:mcpId/refresh-capabilities` | 路径：`mcpId:string` | 无 | `McpInstallationView` | 与 `reconnect` 使用相同实现 |
| `POST /mcps/:mcpId/disable` | 路径：`mcpId:string` | 无 | `McpInstallationView` | 禁用 MCP |
| `POST /mcps/:mcpId/enable` | 路径：`mcpId:string` | 无 | `McpInstallationView` | 启用 MCP |
| `DELETE /mcps/:mcpId` | 路径：`mcpId:string` | 无 | `{ removedAgentBindings:string[] }` | 卸载并清理 Agent 绑定 |

### 3.6 ModelStudent 入园

| 方法与路径 | 参数 | 请求体 | 成功响应 | 用途 |
|---|---|---|---|---|
| `GET /model-provider-presets` | 无 | 无 | `{ items:ModelProviderPresetView[] }` | 查询 Provider 预设 |
| `POST /model-student-tests` | 无 | `ModelStudentCandidateInput` | `ModelStudentTestRecord` | 对候选模型连接做真实能力体检 |
| `GET /model-student-tests/:testId` | 路径：`testId:string` | 无 | `ModelStudentTestRecord` | 查询体检结果 |
| `GET /model-students` | 无 | 无 | `{ items:ModelStudentSummary[] }` | 查询当前账号 ModelStudent |
| `POST /model-students` | 无 | `ModelStudentInstallInput` | `ModelStudentSummary` | 从成功体检结果入园 |
| `GET /model-students/:modelStudentId` | 路径：`modelStudentId:string` | 无 | `ModelStudentDetailView` | 查询不含 Secret 的模型详情 |
| `DELETE /model-students/:modelStudentId` | 路径：`modelStudentId:string` | 无 | `{ modelStudentId:string }` | 删除或归档已入园模型 |

### 3.7 评分

| 方法与路径 | 参数 | 请求体 | 成功响应 | 用途 |
|---|---|---|---|---|
| `GET /score-results/:scoreResultId` | 路径：`scoreResultId:string` | 无 | `ScoreResultRecord` | 查询一条原子评分 |
| `GET /model-students/:modelStudentId/score-groups` | 路径：`modelStudentId:string` | 无 | `{ items:ModelAgentScoreGroupSummary[] }` | 按冻结 Agent 配置聚合评分 |
| `GET /model-students/:modelStudentId/score-groups/:configurationHash` | 路径：`modelStudentId:string`、`configurationHash:string` | 无 | `ModelAgentScoreGroupDetail` | 查询某配置的评分历史 |
| `GET /turns/:turnId/effect-score` | 路径：`turnId:string` | 无 | `TurnEffectScoreRecord|null` | 查询已完成聊天 Turn 的人工效果分 |
| `PUT /turns/:turnId/effect-score` | 路径：`turnId:string` | `TurnEffectScoreDraft` | `TurnEffectScoreRecord` | 保存人工标注，并复用 Runtime 执行分 |

### 3.8 Context Experiment

| 方法与路径 | 参数或请求头 | 请求体 | 成功响应 | 用途 |
|---|---|---|---|---|
| `POST /context-previews` | 无 | `ContextPreviewInputV2` | `ContextPreviewResponseV2` | 按真实 Runtime 序列化路径预检；条件注册 |
| `POST /experiments` | 无 | `ExperimentDraftV2` | `ExperimentRecordV2` | 创建 V2 实验草稿 |
| `PUT /experiments/:experimentId` | 路径：`experimentId:string` | `ExperimentDraftV2` | `ExperimentRecordV2` | 更新尚未冻结的 V2 草稿 |
| `POST /experiments/:experimentId/prepare-run` | 请求头：`Idempotency-Key:string`，必填 | 无 | `ExperimentRecordV2` | 预检、冻结快照并生成 Run |
| `POST /experiments/:experimentId/cancel` | 路径：`experimentId:string` | 无 | `{ experiment:ExperimentRecordV2; activeSessionIds:string[] }` | 取消实验并返回需取消的活动 Session |
| `POST /experiments/:experimentId/tests/:testId/interventions` | 路径：`experimentId:string`、`testId:string` | `ExperimentInterventionInput` | `ExperimentRecordV2` | 记录人工权限或提问介入事实 |
| `GET /experiments` | 查询：`saved?:"true"` | 无 | `AnyExperimentRecord[]` | 查询实验；`saved=true` 只返回已保存记录 |
| `GET /experiments/:experimentId` | 路径：`experimentId:string` | 无 | `AnyExperimentRecord` | 查询实验；可能返回只读 V1 |
| `DELETE /experiments/:experimentId` | 路径：`experimentId:string` | 无 | `{ removedExperimentSessionIds:string[] }` | 删除实验及其 Session/评分引用 |
| `POST /experiments/:experimentId/save` | 路径：`experimentId:string` | 无 | `AnyExperimentRecord` | 设置 `savedAt`；V1 只读 |
| `POST /experiments/:experimentId/annotation-worksheet` | 路径：`experimentId:string` | `{ force?:boolean }`；空体也允许 | `ExperimentAnnotationWorksheet` | 生成或强制重建人工标注工作表 |
| `POST /experiments/:experimentId/variants/:variantId/client-failure` | 路径：`experimentId:string`、`variantId:string` | 无 | `ExperimentRecordV2` | 将尚未结束的 lane 标记为客户端失败 |
| `PUT /experiments/:experimentId/annotations` | 路径：`experimentId:string` | `ExperimentAnnotationsInput` | `ExperimentScorecard` | 保存三维人工注释并计算四维评分 |
| `GET /experiments/:experimentId/scorecard` | 路径：`experimentId:string` | 无 | `ExperimentScorecard` | 查询实验评分卡 |

### 3.9 文件引用

| 方法与路径 | 参数 | 成功响应 | 用途 |
|---|---|---|---|
| `GET /files/:fileReferenceId` | 路径：`fileReferenceId:string` | `FileReference` | 查询 Session-scoped 文件引用 |
| `GET /files/:fileReferenceId/preview` | 路径：`fileReferenceId:string` | `FilePreviewResponse` | 获取安全预览投影 |
| `GET /files/:fileReferenceId/content` | 路径：`fileReferenceId:string` | 二进制，`Content-Disposition: attachment` | 下载原文件 |

### 3.10 Artifact

| 方法与路径 | 认证 | 参数 | 成功响应 | 用途 |
|---|---|---|---|---|
| `GET /public/artifacts/:artifactId/preview` | 匿名 | 路径：`artifactId:string` | `PublicArtifactPreviewResponse` | 预览 active 公共产物 |
| `GET /public/artifacts/:artifactId/content` | 匿名 | 路径：`artifactId:string` | 二进制附件 | 下载 active 公共产物 |
| `GET /public/artifacts/:artifactId/raw` | 匿名 | 路径：`artifactId:string` | 二进制 inline | 读取 active 公共产物主文件 |
| `GET /public/artifacts/:artifactId/bundle/*path` | 匿名 | 路径：`artifactId:string`、`path:string` | 二进制 inline | 读取 active HTML Bundle 子资源 |
| `GET /artifacts` | 登录 | 查询：`query?:string`、`state?:"active"|"archived"|"all"` | `ArtifactListResponse` | 查询当前账号产物 |
| `GET /artifacts/:artifactId` | 登录 | 路径：`artifactId:string` | `ArtifactRecord` | 查询产物详情 |
| `GET /artifacts/:artifactId/preview` | 登录 | 路径：`artifactId:string` | `ArtifactPreviewResponse` | 预览产物 |
| `GET /public/artifacts/:artifactId/pptx-playback` | 匿名 | 路径：`artifactId:string` | `PptxPlaybackResponse` | 创建 active PPTX 只读播放配置；OnlyOffice 条件注册 |
| `GET /artifacts/:artifactId/pptx-playback` | 登录 | 路径：`artifactId:string` | `PptxPlaybackResponse` | 创建账号内 PPTX 只读播放配置；OnlyOffice 条件注册 |
| `GET /onlyoffice/artifacts/:artifactId/raw` | 签名票据 | 路径：`artifactId:string`；查询：`token:string`，必填 | 二进制 inline | OnlyOffice 文档服务器读取固定版本；条件注册 |
| `GET /artifacts/:artifactId/content` | 登录 | 路径：`artifactId:string` | 二进制附件 | 下载产物 |
| `GET /artifacts/:artifactId/raw` | 登录 | 路径：`artifactId:string` | 二进制 inline | 读取产物主文件 |
| `GET /artifacts/:artifactId/bundle/*path` | 登录 | 路径：`artifactId:string`、`path:string` | 二进制 inline | 读取 HTML Bundle 子资源 |
| `POST /artifacts/:artifactId/archive` | 登录 | 路径：`artifactId:string` | `ArtifactRecord` | 归档产物 |
| `POST /artifacts/:artifactId/restore` | 登录 | 路径：`artifactId:string` | `ArtifactRecord` | 恢复产物 |

所有二进制接口至少返回 `content-type`、`content-length`、`content-disposition`、`x-content-type-options:nosniff` 和 `cache-control`。公共读取固定使用 `private, no-store`；登录态 inline 内容默认可按不可变版本长缓存。

### 3.11 各路由错误索引

本节列出各接口族除公共错误外的主要业务错误。未单列的状态码仍以实际 `ApiProblem.status` 为准；资源不存在或不属于当前账号通常统一投影为 `404 NOT_FOUND`，避免泄露资源是否存在。

| 接口范围 | 主要业务错误 |
|---|---|
| `/auth/*` | 凭据错误或会话失效返回认证失败；请求格式错误返回 `VALIDATION_FAILED` |
| `/agents*`、`/capability-options` | `NOT_FOUND`、`CONFLICT`、`CAPABILITY_REFERENCE_INVALID`、`CAPABILITY_STALE` |
| `/session-launches*`、`/sessions*`、`/turns*` | `NOT_FOUND`、`SESSION_BINDING_INVALID`、`SESSION_BUSY`、`TURN_SNAPSHOT_UNAVAILABLE`、`EXECUTION_METRICS_UNAVAILABLE` |
| `/skills*`、`/skill-install-jobs*` | `NOT_FOUND`、`CONFLICT`、`SKILL_SOURCE_NOT_ALLOWED`、`SKILL_SOURCE_NOT_USER_PROVIDED`、`SKILL_SOURCE_URL_LIMIT_EXCEEDED`、`SKILL_SOURCE_NAME_CONFLICT`、`SKILL_VALIDATION_FAILED`、`SKILL_JOB_INTERRUPTED` |
| `/mcp-tests*`、`/mcps*` | `NOT_FOUND`、`CONFLICT`、`MCP_URL_NOT_ALLOWED`、`MCP_AUTH_NOT_SUPPORTED`、`MCP_TEST_EXPIRED`、`MCP_CONNECTION_FAILED`、`MCP_NOT_AVAILABLE` |
| `/model-provider-presets`、`/model-student-tests*`、`/model-students*` | `NOT_FOUND`、`CONFLICT`、`MODEL_URL_NOT_ALLOWED`、`MODEL_CONNECTION_FAILED`、`MODEL_PROBE_EXPIRED`、`MODEL_IN_USE` |
| `/score-results*`、`*/score-groups*`、`*/effect-score` | `NOT_FOUND`、`CONFLICT`、`EXECUTION_METRICS_UNAVAILABLE`、`TURN_SNAPSHOT_UNAVAILABLE` |
| `/context-previews`、`/experiments*` | `NOT_FOUND`、`CONFLICT`、`IDEMPOTENCY_CONFLICT`、`EXPERIMENT_NOT_RUNNABLE`、`EXPERIMENT_READ_ONLY`、`EXPERIMENT_PREVIEW_UNAVAILABLE`、`EXPERIMENT_NO_EFFECTIVE_DIFFERENCE`、`EXPERIMENT_SOURCE_CHANGED`、`LEGACY_EXPERIMENT_READ_ONLY`、`SCORECARD_INCOMPLETE`、`WORKSHEET_NOT_READY`、`WORKSHEET_GENERATOR_UNAVAILABLE`、`WORKSHEET_GENERATION_FAILED`、`WORKSHEET_GENERATION_INVALID` |
| `/files*` | `NOT_FOUND`、`FILE_REFERENCE_FORBIDDEN`、`FILE_PREVIEW_NOT_SUPPORTED` |
| `/artifacts*`、`/public/artifacts*`、`/onlyoffice/artifacts*` | `NOT_FOUND`、`ARTIFACT_FORBIDDEN`、`ARTIFACT_VALIDATION_FAILED`、`ARTIFACT_RESOURCE_LIMIT`、`ARTIFACT_RESOURCE_NOT_FOUND`、`ARTIFACT_BLOB_CORRUPT`；无效或过期 OnlyOffice `token` 返回拒绝访问 |

## 4. Control API 公共数据结构

### 4.1 认证结构

#### `LoginInput`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `username` | `string` | 是 | 用户名 |
| `password` | `string` | 是 | 密码 |

#### `PublicPrincipal`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `principalId` | `string` | 是 | 服务端解析出的账号 ID |
| `username` | `string` | 是 | 展示用户名；本地模式为 `local-admin` |
| `kind` | `"local_admin"|"password_user"` | 是 | 身份类型 |

### 4.2 Agent 结构

#### `AgentInput`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | `string` | 是 | Agent 名称 |
| `description` | `string` | 否 | Agent 描述 |
| `systemPrompt` | `string` | 是 | Agent 系统提示词，保留空白 |
| `builtinTools` | `BuiltinToolBinding[]` | 是 | 内置工具绑定 |
| `builtinSkillIds` | `string[]` | 是 | `builtin:*` 形式的系统 Skill ID |
| `skillInstallationIds` | `string[]` | 是 | 当前账号 ready Skill Installation ID |
| `mcps` | `McpBinding[]` | 是 | MCP 绑定 |
| `historyPolicy` | `HistoryPolicy` | 是 | 历史上下文策略 |
| `memoryPolicy` | `{ mode:"off" }` | 是 | 当前版本只允许关闭记忆 |

#### Agent 子结构

| 类型 | 字段 | 说明 |
|---|---|---|
| `BuiltinToolBinding` | `toolId:string`、`enabled:boolean`、`permission:ToolPermission` | 内置工具及其开关、权限 |
| `ToolPermission` | `"allow"|"ask"|"deny"` | 允许、询问、拒绝 |
| `BuiltinSkillBinding` | `skillId:string`、`enabled:boolean` | 系统 Skill 绑定 |
| `SkillBinding` | `skillInstallationId:string`、`enabled:boolean` | 受管 Skill 绑定 |
| `McpBinding` | `mcpInstallationId:string`、`enabled:boolean`、`tools:McpToolBinding[]`、`resources:McpResourceBinding[]` | 一项 MCP 安装的能力绑定 |
| `McpToolBinding` | `remoteName:string`、`enabled:boolean`、`permission:ToolPermission` | MCP Tool 绑定 |
| `McpResourceBinding` | `uri:string`、`enabled:boolean`、`preload:boolean` | MCP Resource 绑定 |
| `HistoryPolicy` | `{ mode:"none" }` 或 `{ mode:"recent_turns"; maxTurns:number }` | 不带历史，或携带最近 N 轮 |

#### `AgentRecord`

包含 `AgentInput` 中除 `builtinSkillIds`、`skillInstallationIds` 外的字段，并增加：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schemaVersion` | `1` | 是 | 数据版本 |
| `agentId` | `string` | 是 | Agent ID |
| `ownerId` | `string` | 是 | 所属账号 |
| `recordKind` | `"user"|"system_default"|"experiment_policy"` | 否 | 记录来源 |
| `builtinSkills` | `BuiltinSkillBinding[]` | 是 | 已解析的系统 Skill 绑定 |
| `skills` | `SkillBinding[]` | 是 | 已解析的受管 Skill 绑定 |
| `createdAt` | `string` | 是 | ISO 8601 创建时间 |
| `updatedAt` | `string` | 是 | ISO 8601 更新时间 |
| `deletable` | `boolean` | 否 | 当前记录是否允许删除 |

#### `CapabilityOptions`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `builtinTools` | `string[]` | 是 | 可用内置 Tool ID |
| `builtinSkills` | `{ skillId:string; name:string; description:string }[]` | 是 | 可用系统 Skill |
| `runtimeBaseInstruction` | `string` | 是 | Runtime 固定基础指令，仅供配置界面展示 |
| `readySkillInstallationIds` | `string[]` | 是 | 当前账号 ready Skill ID |
| `mcps` | `{ installationId:string; tools:string[]; resources:string[] }[]` | 是 | 当前账号可绑定 MCP 能力 |

`CursorPage<T>` 字段：`items:T[]` 必填；`nextCursor?:string` 为下一页游标。

### 4.3 Session 与 Turn 结构

#### `SessionLaunchInput` 与 `SessionLaunchDraft`

`SessionLaunchInput` 字段：`modelStudentId:string`、`agentId:string`、`promptText:string` 均必填；`artifactMentions?:ArtifactMentionInput[]`、`reasoningProfileOverride?:ConcreteReasoningProfile` 可选。

`SessionLaunchDraft` 在上述字段基础上增加：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schemaVersion` | `1` | 是 | 数据版本 |
| `launchId` | `string` | 是 | 启动草稿 ID |
| `ownerId` | `string` | 是 | 所属账号 |
| `createdAt` | `string` | 是 | ISO 8601 创建时间 |
| `expiresAt` | `string` | 是 | ISO 8601 过期时间 |

`ConcreteReasoningProfile` 枚举：`"fast"|"balanced"|"deep"|"max"`。

#### `SessionSummary`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schemaVersion` | `1` | 是 | 摘要版本 |
| `sessionId` | `string` | 是 | Session ID |
| `purpose` | `"chat"|"experiment"` | 是 | 会话用途 |
| `cwd` | `string` | 是 | 工作目录 |
| `title` | `string` | 是 | 会话标题 |
| `modelStudentId` | `string` | 是 | 固定绑定模型 |
| `agentId` | `string` | 是 | 固定绑定 Agent |
| `reasoningOverride` | `ConcreteReasoningProfile` | 否 | Session 推理档位覆盖 |
| `experimentRef` | `{ experimentId:string; variantId:string }` | 否 | 实验来源 |
| `preview` | `string` | 是 | 最近用户文本摘要，最多 160 字符 |
| `turnCount` | `number` | 是 | Turn 数量 |
| `updatedAt` | `string` | 是 | 更新时间 |
| `createdAt` | `string` | 是 | 创建时间 |

#### `SessionTurnPage`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schemaVersion` | `1` | 是 | 分页结构版本 |
| `session` | `SessionSummary` | 是 | Session 摘要 |
| `turns` | `SessionTurnPageItem[]` | 是 | 本页 Turn |
| `hasMore` | `boolean` | 是 | 是否有更早页 |
| `nextBeforeTurnId` | `string` | 否 | 请求更早页时作为 `beforeTurnId` |

`SessionTurnPageItem` 字段：`turnId:string`、`state:TurnState`、`startedAt:string`、`completedAt?:string`、`entries:SessionEntry[]`。分页响应会排除内部 `provider_continuation` 条目。

#### `TurnView`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schemaVersion` | `1` | 是 | Turn 记录版本 |
| `turnId` | `string` | 是 | Turn ID |
| `state` | `TurnState` | 是 | 活动或终态 |
| `startedAt` | `string` | 是 | 开始时间 |
| `completedAt` | `string` | 否 | 完成时间 |
| `promptEntryId` | `string` | 否 | 用户 Prompt 条目 ID |
| `entryIds` | `string[]` | 否 | 本轮条目 ID |
| `modelStudentId` | `string` | 是 | 响应视图会回退到 Session 绑定 |
| `providerKind` | `string` | 否 | Provider 类型 |
| `model` | `string` | 否 | 模型名 |
| `agentId` | `string` | 是 | 响应视图会回退到 Session 绑定 |
| `agentSnapshotHash` | `string` | 否 | 冻结 Agent 快照哈希 |
| `agentSnapshot` | `AgentSnapshot` | 否 | 冻结策略；字段为 `systemPrompt`、`builtinTools`、`builtinSkills`、`skills`、`mcps`、`historyPolicy`、`memoryPolicy` |
| `capabilitySnapshots` | `{ generation:number; hash:string; snapshot:RuntimeCapabilitySnapshot }[]` | 否 | 各代能力快照 |
| `modelRounds` | `ModelRoundRecord[]` | 否 | 模型轮次记录 |
| `usage` | `TurnTokenUsage` | 否 | 本轮 token 用量 |
| `stopReason` | `string` | 否 | 停止原因 |
| `error` | `{ code:string; message:string; retryable:boolean }` | 否 | 终止错误 |
| `fileReferenceIds` | `string[]` | 否 | 本轮文件引用 |
| `resolvedReasoning` | `ResolvedReasoningSnapshot` | 否 | 冻结推理参数 |
| `sessionId` | `string` | 是 | 所属 Session |
| `purpose` | `"chat"|"experiment"` | 是 | Session 用途 |

`ModelRoundRecord` 字段：`roundIndex:number`、`capabilityGeneration:number`、`contextSummary:ContextSummary`、`startedAt:string` 必填；`providerInput?:ModelContextSerialization`、`providerInputRef?:string`、`providerInputHash?:string`、`providerInputBytes?:number`、`providerInputProvider?:string`、`providerInputModel?:string`、`providerInputFormat?:"json"|"text"`、`completedAt?:string`、`resolvedReasoning?:ResolvedReasoningSnapshot` 可选。

`ResolvedReasoningSnapshot` 字段：`schemaVersion:1`、`requestedProfile:ReasoningProfile`、`resolvedProfile:ConcreteReasoningProfile`、`source:"session_override"|"model_default"`、`providerKind:string`、`model:string`、`native:Record<string,string|number|boolean>`，全部必填。`ReasoningProfile` 为 `"auto"|"fast"|"balanced"|"deep"|"max"`；`ConcreteReasoningProfile` 不包含 `"auto"`。

`RuntimeCapabilitySnapshot` 字段：`tools:{ id:string; modelName:string; origin:"builtin"|"mcp"|"skill_runtime"; schemaHash:string; serverId?:string; remoteName?:string }[]`、`mcpServers:{ serverId:string; protocolEra:"modern"|"legacy"; revision:string; toolSchemaHashes:Record<string,string> }[]`、`skills:{ name:string; contentHash:string; source:"builtin"|"project"|"user"|"git"|"resource" }[]`。

#### `SessionEntry`

| `type` | 字段 | 说明 |
|---|---|---|
| `message` | `role:"user"|"assistant"`、`text`、`turnId`、`messageId`、`createdAt`、`artifactMentions?`、`modelAttemptId?`、`modelAttemptIndex?` | 用户或 Agent 文本 |
| `thought` | `text`、`turnId`、`messageId`、`createdAt`、`modelAttemptId?`、`modelAttemptIndex?` | 思考文本 |
| `context_summary` | `turnId`、`summary:ContextSummary`、`createdAt` | 上下文提要 |
| `token_usage` | `turnId`、`usage:TurnTokenUsage`、`createdAt` | Token 用量 |
| `context_window_usage` | `turnId`、`state:ContextWindowUsageState`、`createdAt` | 下一轮上下文窗口估计 |
| `tool_call` | `turnId`、`toolCallId`、`title`、`name`、`kind:ToolKind`、`status:ToolCallStatus`、`rawInput`、`rawOutput?`、`modelContent?`、`outcomeStatus?`、`content:ToolCallContent[]`、`locations:ToolCallLocation[]`、`createdAt` | Tool 生命周期投影 |

`ToolCallStatus`：`"pending"|"in_progress"|"completed"|"failed"`。`outcomeStatus`：`"success"|"error"|"denied"|"duplicate_blocked"`。

#### `TurnContextView`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schemaVersion` | `1` | 是 | 结构版本 |
| `turn` | `TurnView` | 是 | Turn 详情 |
| `promptText` | `string` | 是 | 用户 Prompt 原文 |
| `answerTexts` | `string[]` | 是 | 本轮 Assistant 文本集合 |
| `sourcePolicy` | `ExperimentContextPolicy` | 是 | 实际冻结的上下文策略 |
| `resolvedReasoning` | `ResolvedReasoningSnapshot` | 否 | 实际推理参数 |
| `agentSnapshotHash` | `string` | 是 | Agent 快照哈希 |
| `capabilitySnapshots` | `{ generation:number; hash:string; snapshot:RuntimeCapabilitySnapshot }[]` | 是 | 能力快照 |
| `modelRounds` | `ModelRoundRecord[]` | 是 | 轮次证据；若落盘使用引用，此接口会补回 `providerInput` |

### 4.4 Skill 结构

`SkillInstallationState`：`"queued"|"validating"|"installing"|"ready"|"capacity_blocked"|"quarantined"|"failed"|"uninstalled"`。
`OperationState`：`"queued"|"running"|"succeeded"|"failed"|"cancelled"|"interrupted"`。

`SkillSource` 为以下联合：

- `{ kind:"github_tree"; repository:string; requestedRef:string; resolvedCommit?:string; subdirectory:string }`
- `{ kind:"resource_bundle"; url:string; resolvedContentHash?:string }`
- `{ kind:"approved_local"; sourceId:string }`

#### `SkillInstallation`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schemaVersion` | `1` | 是 | 数据版本 |
| `skillInstallationId` | `string` | 是 | 安装 ID |
| `ownerId` | `string` | 是 | 所属账号 |
| `skillName` | `string` | 是 | Skill 稳定名称 |
| `displayName` | `string` | 否 | 展示名 |
| `state` | `SkillInstallationState` | 是 | 安装状态 |
| `source` | `SkillSource` | 是 | 来源 |
| `contentHash` | `string` | 否 | 内容哈希 |
| `installedPathRef` | `string` | 否 | 服务端受管路径引用 |
| `securitySummary` | `{ fileCount:number; totalBytes:number; warnings:string[] }` | 否 | 安全扫描摘要 |
| `error` | `PublicErrorRef` | 否 | 失败信息 |
| `createdAt` | `string` | 是 | 创建时间 |
| `updatedAt` | `string` | 是 | 更新时间 |
| `deletable` | `boolean` | 否 | 是否允许卸载 |

#### `SkillInstallJobInput`、`SkillInstallJob`

`SkillInstallJobInput`：`sourceUrls:string[]` 必填；`bindToAgentOnComplete?:boolean`、`agentId?:string` 可选。

`SkillInstallJob` 字段：`schemaVersion:1`、`jobId:string`、`ownerId:string`、`origin:{kind:"manual"}|{kind:"turn";sessionId:string;turnId:string;agentId:string}`、`state:OperationState`、`items:SkillInstallJobItem[]`、`bindToAgentOnComplete:boolean`、`createdAt:string`、`updatedAt:string` 必填，`completedAt?:string` 可选。

`SkillInstallJobItem` 字段：`itemId:string`、`source:SkillSource`、`state:SkillInstallationState` 必填；`skillInstallationId?:string`、`disposition?:"installed"|"reused"|"updated"`、`error?:PublicErrorRef` 可选。

`PublicErrorRef` 字段：`code:PublicErrorCode`、`message:string`、`retryable:boolean` 必填，`requestId?:string` 可选。

### 4.5 MCP 结构

`McpCandidateInput` 字段：`name:string`、`transport:"streamable_http"`、`url:string`、`auth:{kind:"none"}`，全部必填。公网只允许 HTTPS；开发时允许 loopback HTTP；URL 不得带凭据或 fragment。

`McpInstallInput` 字段：`testId:string` 必填，`name?:string` 可选。

`McpCapabilitySnapshot` 字段：

- `schemaVersion:1`、`generation:number`、`discoveredAt:string`；
- `tools:{ name:string; description?:string; inputSchema:unknown; inputSchemaHash:string }[]`；
- `resources:{ uri:string; name?:string; description?:string; mimeType?:string }[]`；
- `prompts:{ name:string; description?:string }[]`。

`McpTestRecord` 字段：`schemaVersion:1`、`testId:string`、`ownerId:string`、`candidateHash:string`、`candidate:McpCandidateInput`、`state:"queued"|"testing"|"succeeded"|"failed"|"expired"`、`createdAt:string`、`expiresAt:string` 必填；`snapshot?:McpCapabilitySnapshot`、`error?:PublicErrorRef` 可选。

`McpInstallationView` 字段：`schemaVersion:1`、`mcpInstallationId:string`、`ownerId:string`、`name:string`、`transport:"streamable_http"`、`url:string`、`authKind:"none"|"externally_managed_bearer"`、`enabled:boolean`、`state:McpConnectionState`、`createdAt:string`、`updatedAt:string` 必填；`snapshot?`、`lastConnectedAt?`、`lastAttemptAt?`、`nextRetryAt?`、`deletable?` 可选。`McpConnectionState` 为 `"installing"|"connecting"|"connected"|"capacity_blocked"|"degraded"|"disconnected"|"disabled"|"failed"|"uninstalled"`。

### 4.6 ModelStudent 结构

#### `ModelStudentCandidateInput`

- Ollama：`{ presetId:"ollama"; displayName:string; model:string; baseUrl:string }`
- OpenAI：`{ presetId:"openai"; displayName:string; model:string; apiKey:string }`
- 硅基流动：`{ presetId:"siliconflow"; displayName:string; model:string; apiKey:string }`
- 自定义 Responses：`{ presetId:"custom_responses"; displayName:string; model:string; baseUrl:string; apiKey:string }`

#### `ModelProviderPresetView`

字段：`schemaVersion:1`、`presetId:"ollama"|"openai"|"custom_responses"|"siliconflow"|"anthropic"`、`displayName:string`、`description:string`、`protocol:ProviderProtocol`、`availability:"ready"|"planned"`、`baseUrl:{mode:"fixed";value:string}|{mode:"editable";defaultValue?:string}`、`auth:{scheme:"none"|"bearer"|"api_key_header";apiKeyLabel:string}`、`modelEntry:"manual"|"discoverable"`。

`ProviderProtocol`：`"ollama_native"|"openai_responses"|"openai_chat_completions"|"anthropic_messages"`。当前 `anthropic` 仅为 `planned`，不是可入园实现。

#### `ProviderCapabilitySnapshot`

字段：`schemaVersion:1`、`protocol`、`adapterRevision:string`、`probeVersion:number`、`connectionFingerprint:string`、`streaming:boolean`、`text:boolean`、`toolCalls:boolean`、`toolContinuation:boolean`、`usage:boolean`、`thought:boolean`、`reasoning:ProviderReasoningProbe`、`testedAt:string`。

`ProviderReasoningProbe` 字段：`capability:ModelReasoningCapability`、`nativeByProfile:Partial<Record<ConcreteReasoningProfile,Record<string,string|number|boolean>>>`、`acceptedNativeValues:Record<string,string|number|boolean>[]`。

`ModelReasoningCapability` 字段：`schemaVersion:1`、`control:"fixed"|"toggle"|"effort_levels"|"token_budget"`、`adjustable:boolean`、`supportedProfiles:ConcreteReasoningProfile[]`、`defaultProfile:ConcreteReasoningProfile`，以及可选 `native:{parameter:string;values?:(string|number|boolean)[];minBudget?:number;maxBudget?:number}`。

#### 测试、安装和详情

- `ModelStudentTestRecord`：`schemaVersion:1`、`testId`、`ownerId`、`candidate:ModelStudentCandidatePublic`、`state:"testing"|"succeeded"|"failed"|"expired"`、`createdAt`、`expiresAt`；可选 `snapshot:ProviderCapabilitySnapshot`、`error:{code;message;retryable}`。
- `ModelStudentCandidatePublic`：`presetId`、`displayName`、`baseUrl`、`model`、`protocol`；不含 Secret。
- `ModelStudentInstallInput`：`testId:string` 必填；`displayName?:string`、`defaultReasoningProfile?:ConcreteReasoningProfile`、`contextWindowTokens?:number` 可选。
- `ModelStudentSummary`：`schemaVersion:1`、`modelStudentId`、`displayName`、`sizeClass:"small"|"large"`、`providerKind`、`model`、`status:"ready"|"capacity_blocked"|"unavailable"|"unknown"`、`supports:{streaming;toolCalls;thought;usage;reasoning}`；可选 `contextWindowTokens`、`lastCheckedAt`、`statusMessage`、`deletable`。
- `ModelStudentDetailView` 在 `ModelStudentSummary` 上增加 `admission`：`schemaVersion:1`、`presetId`、`protocol`、`baseUrl`、`credentialConfigured:boolean`、`credentialHint?:string`、`defaultReasoningProfile`、`snapshot`、`createdAt`、`updatedAt`。

### 4.7 评分结构

#### `TurnEffectScoreDraft`

| 路径 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schemaVersion` | `1` | 是 | 结构版本 |
| `annotations.understanding.requirements[]` | `{ requirementId:string; label:string; weight:number; verdict:"met"|"missed"|"unmarked" }` | 是 | 理解能力逐需求标注 |
| `annotations.understanding.completed` | `boolean` | 是 | 理解维度是否完成 |
| `annotations.planning.score` | `number` | 否 | 规划分 |
| `annotations.planning.completed` | `boolean` | 是 | 规划维度是否完成 |
| `annotations.output.score` | `number` | 是 | 输出分 |
| `annotations.output.marks[]` | `{ markId?:string; answerSectionId:string; start:number; end:number; verdict:"effective"|"partial"; quotedTextHash:string }` | 是 | 输出文本选区标注 |
| `annotations.output.artifactScore` | `number` | 否 | 产物型输出分 |
| `annotations.output.completed` | `boolean` | 是 | 输出维度是否完成 |

`TurnEffectScoreRecord` 增加 `sessionId:string`、`turnId:string`、`scoreResultId?:string`、`executionScore:number`、`savedAt:string`。

#### `ScoreResultRecord`

字段：`schemaVersion:1`、`scoreResultId:string`、`ownerId:string`、`modelStudentId:string`、`source:ScoreResultSource`、`sourceTitle:string`、`agentConfiguration:ScoreAgentConfigurationSnapshot`、`dimensionScores:{understanding?:number;planning?:number;output?:number;execution:number}`、`status:"draft"|"complete"`、`totalScore?:number`、`createdAt:string`、`updatedAt:string`。

`ScoreResultSource`：`{kind:"context_experiment";experimentId:string;testId:string;scorecardId:string}` 或 `{kind:"turn_effect";sessionId:string;turnId:string}`。

`ScoreAgentConfigurationSnapshot` 字段：`configurationHash`、`agentSnapshotHash`、`agentId`、`agentName`、`systemPrompt`、`builtinTools`、`builtinSkills`、`skills`、`mcps`、`historyPolicy`、`memoryPolicy`、`reasoning`；其中绑定结构与 Agent 章节一致，`reasoning` 为冻结推理快照。

`ModelAgentScoreGroupSummary` 字段：`configurationHash`、`agentName`、`sampleCount`、`averageScore`、`minScore`、`maxScore`、`lastScoredAt`。
`ModelAgentScoreGroupDetail` 字段：`summary:ModelAgentScoreGroupSummary`、`configuration:ScoreAgentConfigurationSnapshot`、`history:ScoreResultRecord[]`。

### 4.8 Context Experiment 结构

#### 写入结构

`ExperimentDraftV2`：`schemaVersion:2`、`name:string`、`promptText:string`、`tests:ExperimentTestDraftV2[]` 必填；`artifactMentions?:ArtifactMentionInput[]`、`sourceRef?:{kind:"turn";id:string}` 可选。`tests` 必须为 2～3 项并按 A、B、C 排列。

`ExperimentTestDraftV2`：`testId:string`、`label:"A"|"B"|"C"`、`sourceAgent:{agentId:string;name:string;updatedAt:string}`、`modelStudentId:string`、`reasoningProfile:"auto"|ConcreteReasoningProfile`、`policy:ExperimentContextPolicy`。

`ExperimentContextPolicy`：`systemPrompt:string`、`builtinTools:BuiltinToolBinding[]`、`builtinSkillIds:string[]`、`skillInstallationIds:string[]`、`mcps:McpBinding[]`、`historyPolicy:HistoryPolicy`、`memoryPolicy:{mode:"off"}`。

`ContextPreviewInputV2`：`schemaVersion:2`、`promptText:string`、`test:ExperimentTestDraftV2` 必填，`artifactMentions?:ArtifactMentionInput[]` 可选。

`ExperimentInterventionInput`：`interactionId:string`、`kind:"permission"|"elicitation"`、`summary:string`、`decision:string`，全部必填；服务端补 `operatorId` 和 `resolvedAt`。

`ExperimentAnnotationsInput`：

- `understanding`：`requirements:{requirementId;label;weight}[]`、`marks:{variantId;requirementId;verdict:"met"|"missed"}[]`、`completedAt?:string`；
- `planning`：`scores:{variantId;score:number}[]`、`completedAt?:string`；
- `output`：`marks:{markId?;variantId;answerSectionId;start;end;verdict:"effective"|"partial"|"none";quotedTextHash}[]`、`artifactScores?:{variantId;score:number}[]`、`completedAt?:string`。

#### `ContextPreviewResponseV2`

字段：`schemaVersion:2`、`runnable:boolean`、`diagnostics:{code:string;message:string;path?:string}[]`、`agentSnapshotHash:string`、`capabilityHash:string`、`effectiveConfigurationHash:string`、`contextSummary:ContextSummary`、`providerInput:ModelContextSerialization`、`providerInputHash:string`、`providerInputBytes:number`、`resolvedReasoning:ResolvedReasoningSnapshot`、`model:{modelStudentId;displayName;providerKind;model;contextWindowTokens?}`、`history:{configuredPolicy:HistoryPolicy;actualHistoryTurns:0}`。

`ModelContextSerialization`：`provider:string`、`model:string`、`format:"json"|"text"`、`value:string`。

#### `ExperimentRecordV2`

字段：`schemaVersion:2`、`experimentId`、`ownerId`、`name`、`status:"draft"|"prepared"|"running"|"completed"|"partially_failed"|"failed"|"cancelled"|"interrupted"`、`promptText`、`worksheetModelStudentId`、`tests`、`runs:ExperimentRunV2[]`、`createdAt`、`updatedAt`；可选 `artifactMentions`、`sourceRef`、`snapshots:ExperimentTestSnapshotV2[]`、`prepareKey`、`annotationWorksheet`、`savedAt`。

`ExperimentRunV2`：`runId`、`testId`、`snapshotId`、`status:ExperimentRunStatus`、`answerTexts:string[]` 必填；可选 `acpSessionId`、`turnId`、`executionMetrics`、`runtimeFacts`、`error`、`startedAt`、`completedAt`、`hadHumanIntervention`、`interventions`。`ExperimentRunStatus` 为 `"pending"|"session_created"|"running"|"completed"|"failed"|"cancelled"|"interrupted"`。

`ExperimentTestSnapshotV2`：`snapshotId`、`testId`、`label`、`sourceAgent`、`policy`、`agentSnapshotHash`、`model:{modelStudentId;providerKind;model;capabilityHash;contextWindowTokens?}`、`reasoning`、`dependencies:{kind:"skill"|"mcp";id;generation?;contentHash}[]`、`runtimePrompt:{version:"runtime_system_prompt_v1";hash}`、`firstRequestPreview:{contextHash;providerInputHash;providerInputBytes;estimatedTokens;actualHistoryTurns:0}`、`effectiveConfigurationHash`、`frozenAt`。

`ExecutionMetricsSnapshot`：`evaluationRecordId`、`variantId`、`normallyCompleted`、`firstTokenLatencyMs?`、`totalDurationMs`、`toolSuccessCount`、`toolFailureCount`、`errorCount`、`permissionViolationCount`、`hasRepeatedToolCall`、`modelRoundCount`、`toolCallCount`、`totalContextTokens`、`totalOutputTokens`。

`ExperimentRunRuntimeFacts`：`agentSnapshotHash?`、`capabilityGenerations:number`、`capabilityToolNames:string[]`、`contextSources:{kind;title;estimatedTokens;truncated?}[]`、`modelRounds?`、`providerInputHash?`、`providerInputBytes?`、`usage?`、`stopReason?`。

#### 工作表与评分卡

`ExperimentAnnotationWorksheet` 字段：

- `schemaVersion:1`、`worksheetId`、`experimentId`；
- `requirements:{requirementId;label;weight;sourceVariantIds?;matchedVariantIds?}[]`；
- `workflows:{variantId;steps:{stepId;label}[]}[]`；
- `outputSections:{variantId;sections:{answerSectionId;label;start;end;quotedTextHash;preview}[]}[]`；
- `generator:{modelStudentId;providerKind;model;promptVersion:"annotation_worksheet_v1"|"annotation_worksheet_v2"|"annotation_worksheet_v3"|"annotation_worksheet_v4"|"annotation_worksheet_v5";inputHash;outputHash;generatedAt}`。

`ExperimentScorecard` 字段：`schemaVersion:1`、`scorecardId`、`experimentId`、`rubric`、`annotations:{understanding;planning;output}`、`variants:VariantFourDimensionScore[]`、`ranking?:{rank;variantIds;totalScore}[]`、`winnerVariantIds?:string[]`、`status:"draft"|"complete"`、`createdAt`、`updatedAt`。

`VariantFourDimensionScore`：`variantId`、`scoreResultId?`、`dimensionScores:{understanding?;planning?;output?;execution}`、`executionEvidence:{metrics:ExecutionMetricsSnapshot;componentScores:{completion;toolReliability;errorHygiene;permissionSafety;noRepeatedCalls;responsiveness}}`、`totalScore?`。

`GET /experiments` 和 `GET /experiments/:experimentId` 也可能返回 `LegacyExperimentRecordV1`。V1 字段为 `schemaVersion:1`、`experimentId`、`ownerId`、`name`、`mode:"fresh_prompt"|"history_turn"`、`status`、`modelStudentId`、`sourceAgentId`、`promptText`、`sourceTurnId?`、`variants:ExperimentVariant[]`、`runs:ExperimentRun[]`、`annotationWorksheet?`、`savedAt?`、`createdAt`、`updatedAt`；当前写接口不会创建或修改 V1。

### 4.9 文件与 Artifact 结构

#### `FileReference` 与预览

`FileReference`：`schemaVersion:1`、`fileReferenceId`、`ownerId`、`sessionId`、`turnId`、`displayName`、`relativePath`、`mimeType`、`byteLength:number`、`sha256`、`previewKind:FilePreviewKind`、`createdAt`。`FilePreviewKind` 为 `"markdown"|"static_html"|"text"|"image"|"pdf"|"pptx"|"unsupported"`。

`FilePreviewResponse`：`file:FileReference`，以及 `content` 联合：`{kind:"markdown";markdown}`、`{kind:"static_html";html;csp}`、`{kind:"text";text}`、`{kind:"image"|"pdf"|"pptx";contentUrl}` 或 `{kind:"unsupported"}`。

#### `ArtifactRecord`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schemaVersion` | `1` | 是 | 数据版本 |
| `artifactId` | `string` | 是 | 稳定产物 ID |
| `ownerId` | `string` | 是 | 所属账号 |
| `sourceSessionId` | `string` | 是 | 来源 Session |
| `sourceTurnId` | `string` | 是 | 来源 Turn |
| `kind` | `"file"|"html_bundle"` | 是 | 产物类型 |
| `displayName` | `string` | 是 | 展示文件名 |
| `state` | `"active"|"archived"` | 是 | 生命周期状态 |
| `seriesId` | `string` | 否 | 版本系列 ID；旧记录缺失时视为 `artifactId` |
| `version` | `number` | 否 | 用户可见版本；旧记录缺失时视为 1 |
| `primary` | `ArtifactBlobRef` | 是 | 主文件 Blob |
| `manifest` | `HtmlBundleManifest` | 否 | HTML Bundle 清单 |
| `revisions` | `ArtifactRevision[]` | 否 | 最近修订历史 |
| `operationId` | `string` | 是 | 发布操作 ID |
| `createdAt` | `string` | 是 | 创建时间 |
| `updatedAt` | `string` | 是 | 更新时间 |

`ArtifactBlobRef`：`sha256:string`、`byteLength:number`、`mimeType:string`。
`HtmlBundleManifest`：`entryPath:string`、`files:Record<string,ArtifactBlobRef>`。
`ArtifactRevision`：`revisionId`、`primary`、`manifest?`、`sourceSessionId`、`sourceTurnId`、`operationId`、`createdAt`。

`ArtifactMentionInput` 只有 `artifactId:string`。`ArtifactMention` 增加 `uri`、`displayName`、`kind`、`mimeType`、`byteLength`。

`ArtifactPreviewContent`：`{kind:"markdown";markdown}`、`{kind:"static_html";html;csp}`、`{kind:"text";text}`、`{kind:"image"|"pdf"|"pptx"|"unsupported";contentUrl}`。`ArtifactPreviewResponse` 为 `{artifact:ArtifactRecord;content:ArtifactPreviewContent}`。

`PublicArtifactView` 只含 `artifactId`、`displayName`、`kind`、`version:number`、`primary:{byteLength:number;mimeType:string}`。`PublicArtifactPreviewResponse` 为 `{artifact:PublicArtifactView;content:ArtifactPreviewContent}`。

`PptxPlaybackResponse` 字段：`documentServerApiUrl:string`、`config`。`config` 固定包含 `type:"embedded"`、`documentType:"slide"`、`document:{fileType:"pptx";key;title;url;permissions:{download:false;edit:false;print:false}}`、`editorConfig:{lang:"zh-CN";mode:"view";customization:{compactHeader:true;hideRightMenu:true;toolbarHideFileName:true};embedded:{autostart:"player";toolbarDocked:"bottom"}}`，可选 `token:string`。

## 5. ACP WebSocket 接口

### 5.1 传输与消息信封

| 项目 | 当前实现 |
|---|---|
| WebSocket 路径 | `/acp` |
| 应用协议 | ACP SDK 1.3.0，JSON-RPC 2.0 语义 |
| 单条入站消息上限 | 1 MiB |
| WebSocket 压缩 | 关闭 `perMessageDeflate` |
| 认证 | 与 Control API 共用登录身份；升级前由 Remote 解析 Cookie |

请求：`{ jsonrpc:"2.0"; id:string|number; method:string; params?:object|null }`。
成功响应：`{ jsonrpc:"2.0"; id:string|number; result:object|null }`。
失败响应：`{ jsonrpc:"2.0"; id:string|number; error:{ code:number; message:string; data?:unknown } }`。
通知：`{ jsonrpc:"2.0"; method:string; params?:object|null }`，没有 `id`，也不等待响应。

常见错误码：`-32602` 参数无效；`-32000` 会话正忙或当前时序不允许；`-32002` 当前 Session 绑定的模型或 Agent 不可用；SDK 还允许标准 JSON-RPC 错误码。

### 5.2 当前实际注册方法

| 方向 | 类型 | 方法 | 当前实现 |
|---|---|---|---|
| Client → Agent | 请求 | `initialize` | 已实现 |
| Client → Agent | 请求 | `session/new` | 已实现 |
| Client → Agent | 请求 | `session/list` | 已实现 |
| Client → Agent | 请求 | `session/load` | 已实现；回放最近一页 |
| Client → Agent | 请求 | `session/resume` | 已实现；默认零回放，带项目游标时补增量 |
| Client → Agent | 请求 | `session/close` | 已实现 |
| Client → Agent | 请求 | `session/set_config_option` | 已实现；只支持推理档位 |
| Client → Agent | 请求 | `session/prompt` | 已实现；当前只接受非空文本 |
| Client → Agent | 通知 | `session/cancel` | 已实现 |
| Agent → Client | 通知 | `session/update` | 已实现：文本、思考和 Tool 生命周期 |
| Agent → Client | 扩展通知 | `model-kindergarten/session/context-summary` | 已实现 |
| Agent → Client | 扩展通知 | `model-kindergarten/session/token-usage` | 已实现 |
| Agent → Client | 扩展通知 | `model-kindergarten/session/context-window-usage` | 已实现 |
| Agent → Client | 扩展通知 | `model-kindergarten/session/turn-state` | 已实现 |
| Agent → Client | 扩展通知 | `model-kindergarten/session/execution-trace` | 已实现；实验 Session 才投影 |
| Agent → Client | 反向请求 | `session/request_permission` | 已实现 |
| Agent → Client | 反向请求 | `elicitation/create` | 已实现，实验性 ACP 能力 |

### 5.3 Client → Agent 请求

#### `initialize`

请求字段：`protocolVersion:number` 必填；`clientCapabilities?:ClientCapabilities`、`clientInfo?:{name:string;title?:string;version:string}`、`_meta?:Record<string,unknown>|null` 可选。

`clientInfo` 实际类型为 `Implementation`：`name:string`、`version:string` 必填；`title?:string|null`、`_meta?:Record<string,unknown>|null` 可选。

`ClientCapabilities` 字段如下。当前 Agent 接收并校验这些标准字段，但业务逻辑不读取客户端声明；是否调用反向能力由当前项目自己的会话实现决定。

| 字段 | 类型 | 必填 | 中文说明 |
|---|---|---|---|
| `fs` | `FileSystemCapabilities` | 否 | 文件系统反向能力；字段为 `readTextFile?:boolean`、`writeTextFile?:boolean`、`_meta?` |
| `terminal` | `boolean` | 否 | 是否支持全部 `terminal/*` 反向方法 |
| `session` | `ClientSessionCapabilities|null` | 否 | Session 扩展能力；`configOptions?.boolean?:{}|null` 表示支持布尔配置项，另可带 `_meta` |
| `plan` | `PlanCapabilities|null` | 否 | 实验性；`{}` 表示可接收 `plan_update` 和 `plan_removed` |
| `auth` | `AuthCapabilities` | 否 | 实验性；`terminal?:boolean` 表示支持终端认证方式 |
| `elicitation` | `ElicitationCapabilities|null` | 否 | 实验性；`form?:{}|null`、`url?:{}|null` 分别声明表单和 URL 提问能力 |
| `nes` | `ClientNesCapabilities|null` | 否 | 实验性；`jump?:{}|null`、`rename?:{}|null`、`searchAndReplace?:{}|null` 声明 NES 类型 |
| `positionEncodings` | `PositionEncodingKind[]` | 否 | 实验性；按偏好排列，枚举为 `"utf-16"|"utf-32"|"utf-8"` |
| `_meta` | `Record<string,unknown>|null` | 否 | ACP 扩展元数据 |

当前响应字段：

- `protocolVersion:number`：支持请求版本时原样返回，否则返回 SDK 当前版本；
- `agentCapabilities.loadSession:true`；
- `agentCapabilities.promptCapabilities:{image:false,audio:false,embeddedContext:false}`；
- `agentCapabilities.sessionCapabilities:{list:{},resume:{},close:{}}`；
- `agentInfo:{name:"models-kindergarten";title:"Models Kindergarten";version:"0.2.0"}`。

#### `session/new`

请求字段：`cwd:string`、`mcpServers:McpServer[]` 必填；`additionalDirectories?:string[]`、`_meta?` 可选。项目要求 `_meta.modelKindergarten.sessionBinding` 或实验绑定能解析出 `modelStudentId` 与 `agentId`。

当前响应：`{ sessionId:string; configOptions:SessionConfigOption[] }`。

`McpServer` 是 ACP 标准联合：HTTP `{type:"http";name;url;headers:{name;value}[]}`、SSE `{type:"sse";name;url;headers}`、ACP `{type:"acp";name;serverId}` 或 stdio `{name;command;args:string[];env:{name;value}[]}`。Models-Kindergarten 的受管 MCP 实际由 Remote 能力解析，不依赖浏览器直接注入任意 Server。

#### `session/list`

请求字段：`cwd?:string|null`、`cursor?:string|null`、`_meta?` 均可选。当前实现使用 `cwd` 过滤当前账号 `chat` Session，不消费 `cursor`。

响应：`{ sessions:SessionInfo[] }`。`SessionInfo` 字段：`sessionId:string`、`cwd:string` 必填；`additionalDirectories?:string[]`、`title?:string|null`、`updatedAt?:string|null`、`_meta?` 可选。当前实现不返回 `nextCursor`。

#### `session/load`

请求字段：`sessionId:string`、`cwd:string`、`mcpServers:McpServer[]` 必填；`additionalDirectories?:string[]`、`_meta?` 可选。

行为：校验账号和 `cwd`，通过 `session/update` 回放最近一页聊天条目，并在有活动 Turn 时发送 Turn 状态。响应为 `{ configOptions:SessionConfigOption[] }`。

#### `session/resume`

请求字段：`sessionId:string`、`cwd:string` 必填；`additionalDirectories?:string[]`、`mcpServers?:McpServer[]`、`_meta?` 可选。

行为：无项目游标时零历史回放，只重新挂接活动交互；带 `SessionResumeMeta` 时只补指定活动 Turn 的文本缺口和快照型状态。响应为 `{ configOptions:SessionConfigOption[] }`。

#### `session/close`

请求字段：`sessionId:string` 必填，`_meta?` 可选。行为等同先取消当前工作，再关闭该 ACP 会话通道。响应无业务字段。

#### `session/set_config_option`

请求字段：`sessionId:string`、`configId:string`、`value:string|boolean` 必填，`type?:"boolean"`、`_meta?` 可选。

当前只接受 `configId:"reasoning_profile"` 和字符串 `value:"auto"|"fast"|"balanced"|"deep"|"max"`。活动回答期间不可修改，模型不支持的档位会被拒绝。响应 `{ configOptions:SessionConfigOption[] }`。

`SessionConfigOption` 当前为 select：`type:"select"`、`id:"reasoning_profile"`、`name:string`、`description:string`、`category:"thought_level"`、`currentValue:string`、`options:{value:string;name:string;description?:string|null}[]`。

#### `session/prompt`

请求字段：`sessionId:string`、`prompt:ContentBlock[]` 必填，`_meta?` 可选。虽然 ACP `ContentBlock` 支持文本、图片、音频和资源，当前实现会合并 `type:"text"` 内容，并拒绝没有非空文本的请求；初始化能力也明确声明不支持图片、音频和嵌入上下文。

`ContentBlock` 标准联合字段：

| `type` | 必填字段 | 可选字段 | 当前处理 |
|---|---|---|---|
| `"text"` | `text:string` | `annotations?:Annotations|null`、`_meta?` | 合并所有非空 `text` 后送入 Runtime |
| `"image"` | `data:string`、`mimeType:string` | `uri?:string|null`、`annotations?`、`_meta?` | 可通过协议校验，但当前 Prompt 实现不消费 |
| `"audio"` | `data:string`、`mimeType:string` | `annotations?`、`_meta?` | 可通过协议校验，但当前 Prompt 实现不消费 |
| `"resource_link"` | `name:string`、`uri:string` | `description?:string|null`、`mimeType?:string|null`、`size?:number|null`、`title?:string|null`、`annotations?`、`_meta?` | 当前 Prompt 实现不消费 |
| `"resource"` | `resource:TextResourceContents|BlobResourceContents` | `annotations?`、`_meta?` | 当前 Prompt 实现不消费 |

`TextResourceContents`：`text:string`、`uri:string` 必填；`mimeType?:string|null`、`_meta?` 可选。`BlobResourceContents`：`blob:string`（Base64）、`uri:string` 必填；`mimeType?:string|null`、`_meta?` 可选。

`Annotations`：`audience?:Role[]|null`、`lastModified?:string|null`、`priority?:number|null`、`_meta?`；`Role` 为 `"assistant"|"user"`。

响应：`{ stopReason:"end_turn"|"max_tokens"|"cancelled" }`。ACP SDK 还定义 `"max_turn_requests"|"refusal"`，但当前代码不会产生这两项。

#### `session/cancel`

通知字段：`sessionId:string` 必填，`_meta?` 可选。取消待开始或正在执行的 Prompt；通知无响应。

### 5.4 项目 `_meta` 扩展

所有项目扩展都放在 `_meta.modelKindergarten` 下。

| 扩展 | 字段 | 用途 |
|---|---|---|
| `sessionBinding` | `{schemaVersion:1;binding:{schemaVersion:1;modelStudentId:string;agentId:string}}` | `session/new` 固定绑定模型和 Agent |
| `experimentRunRef` | `{schemaVersion:1;experimentId:string;variantId:string}` | 标识实验 lane Session |
| `prompt` | `{schemaVersion:1;turnId:string;operationId?:string;artifactMentions?:{artifactId:string}[]}` | 固定 Turn ID、关联操作和 Artifact Mention |
| `sessionResume` | `SessionResumeMeta` | 断线续传文本游标 |
| `message` | `MessageMeta` | 文本 Chunk 的 Turn、序号、终止和模型重试代次 |
| `operation` | `{schemaVersion:1;kind:"skill_install";operationId:string;state:OperationState;itemStates?:{itemId;label;state}[]}` | Tool 输出关联长任务状态 |
| `fileReferences` | `{schemaVersion:1;fileReferenceIds:string[]}` | Tool 输出关联 Session 文件 |

`SessionResumeMeta`：`schemaVersion:1`、`turnId:string`、`messages:Record<string,SessionResumeTextCursor>`、`thoughts:Record<string,SessionResumeTextCursor>`。`SessionResumeTextCursor`：`textLength:number`、`nextChunkIndex:number`、`modelAttemptId?:string`。

`MessageMeta`：`schemaVersion:1`、`turnId:string`、`chunkIndex:number` 必填；`final?:boolean`、`artifactMentions?:ArtifactMention[]`、`modelAttempt?:{id:string;index:number;reset?:boolean}` 可选。

### 5.5 Agent → Client `session/update`

通知信封：`{ sessionId:string; update:SessionUpdate; _meta?:Record<string,unknown>|null }`。

当前实际发送的 `SessionUpdate` 只有五类：

| `sessionUpdate` | 字段 | 说明 |
|---|---|---|
| `user_message_chunk` | `content:{type:"text";text:string}`、`messageId:string`、`_meta.modelKindergarten.message` | 回显并回放用户消息 |
| `agent_message_chunk` | 同上 | 流式 Agent 正文 |
| `agent_thought_chunk` | 同上 | 流式思考文本 |
| `tool_call` | `ToolCall` 字段 | 创建 Tool Call |
| `tool_call_update` | `ToolCallUpdate` 字段 | 更新 Tool Call |

`ToolCall` 字段：`toolCallId:string`、`title:string` 必填；`name?:string|null`、`kind?:ToolKind`、`status?:ToolCallStatus`、`content?:ToolCallContent[]`、`locations?:ToolCallLocation[]`、`rawInput?:unknown`、`rawOutput?:unknown`、`_meta?` 可选。

`ToolCallUpdate` 只有 `toolCallId:string` 必填；其余 `kind`、`status`、`title`、`name`、`content`、`locations`、`rawInput`、`rawOutput`、`_meta` 均为可选增量字段。

`ToolKind`：`"read"|"edit"|"delete"|"move"|"search"|"execute"|"think"|"fetch"|"switch_mode"|"other"`。
`ToolCallLocation`：`path:string` 必填，`line?:number|null` 可选。
`ToolCallContent`：`{type:"content";content:ContentBlock}`、`{type:"diff";path:string;oldText?:string|null;newText:string}` 或 `{type:"terminal";terminalId:string}`。

### 5.6 Agent → Client 扩展通知

#### `model-kindergarten/session/context-summary`

参数：`{ sessionId:string; summary:ContextSummary }`。

`ContextSummary`：`schemaVersion:1`、`turnId:string`、`items:ContextSummaryItem[]`、`totalEstimatedTokens:number`。`ContextSummaryItem`：`id`、`kind:ContextSummaryKind`、`title`、`estimatedTokens` 必填；`detail?`、`itemCount?`、`trust?:"trusted"|"approved"|"untrusted"`、`raw?:ModelContextSerialization` 可选。

`ContextSummaryKind`：`"system_instruction"|"available_tools"|"skill_catalog"|"mcp_resource_catalog"|"mcp_resource"|"session_history"|"truncated_history"`。

#### `model-kindergarten/session/token-usage`

参数：`{sessionId:string;usage:TurnTokenUsage}`。`TurnTokenUsage`：`schemaVersion:1`、`turnId`、`modelRequests:number`、`components:TokenUsageComponent[]` 必填；`inputTokens?`、`outputTokens?`、`cachedInputTokens?`、`reasoningOutputTokens?` 可选。

`TokenUsageComponent`：`category:"current_prompt"|"reasoning"|"tool_call"|"answer"`、`targetType:"message"|"thought"|"tool_call"`、`targetId:string`、`estimatedTokens:number`。

#### `model-kindergarten/session/context-window-usage`

参数：`{sessionId:string;state:ContextWindowUsageState}`。`state` 为 `{schemaVersion:1;status:"available";afterTurnId;estimatedTokens;windowTokens;basis:"next_prompt_base"}`，或 `{schemaVersion:1;status:"unavailable";afterTurnId;reason:"unknown_window"|"preview_failed"}`。

#### `model-kindergarten/session/turn-state`

参数：`{sessionId:string;turn:TurnState}`。

活动状态：`{schemaVersion:1;turnId;status:"active";phase:TurnActivePhase;waitingFor:{permission:number;input:number};pendingInteractions:TurnPendingInteraction[]}`。`TurnActivePhase`：`"accepted"|"preparing_context"|"model_streaming"|"tool_execution"|"finalizing"`。

终态：`{schemaVersion:1;turnId;status:"completed"|"failed"|"cancelled"|"interrupted"}`。

`TurnPendingPermissionInteraction`：`schemaVersion:1`、`interactionId`、`kind:"permission"`、`toolCall:{toolCallId;title;name;kind;rawInput;locations}`、`options:{optionId;name;kind:"allow_once"|"allow_always"|"reject_once"|"reject_always"}[]`、`requestedAt`。

`TurnPendingElicitationInteraction`：`schemaVersion:1`、`interactionId`、`kind:"elicitation"`、`toolCallId`、`message`、`requestedSchema:{type:"object";properties:Record<string,unknown>;required?:string[]}`、`requestedAt`。

#### `model-kindergarten/session/execution-trace`

参数：`{sessionId:string;event:LiveExecutionEvent}`。所有事件都有 `schemaVersion:1`、`turnId:string`、`sequence:number`，再按 `type` 增加：

- `model_round_started`：`roundIndex`、`startedAt`；
- `model_attempt_started`：`roundIndex`、`attemptId`、`attemptIndex`、`maxAttempts`、`startedAt`；
- `model_attempt_failed`：`roundIndex`、`attemptId`、`attemptIndex`、`completedAt`、`error:{code;message;retryable}`、`retryDelayMs?`；
- `model_attempt_completed`：`roundIndex`、`attemptId`、`attemptIndex`、`completedAt`；
- `tool_call_started`：`roundIndex`、`toolCallId`、`name`、`title`、`startedAt`；
- `tool_call_completed`：`roundIndex`、`toolCallId`、`completedAt`、`status:"success"|"error"|"denied"|"duplicate_blocked"`、`error?:{code;message}`。

### 5.7 Agent → Client 反向请求

#### `session/request_permission`

请求参数：`sessionId:string`、`toolCall:ToolCallUpdate`、`options:PermissionOption[]` 必填，`_meta?` 可选。当前发送的 `toolCall.status` 固定为 `pending`，选项固定为：

- `{optionId:"allow-once";name:"允许本次执行";kind:"allow_once"}`
- `{optionId:"reject-once";name:"拒绝本次执行";kind:"reject_once"}`

客户端响应：`{outcome:{outcome:"cancelled"}|{outcome:"selected";optionId:string}}`。只有选中 `allow-once` 才视为允许。

#### `elicitation/create`

当前请求参数：`sessionId:string`、`toolCallId:string`、`mode:"form"`、`message:string`、`requestedSchema:{type:"object";properties:{answer:{type:"string";title:"你的回答";minLength:1;maxLength:4000}};required:["answer"]}`。

客户端响应：`{action:"accept";content:{answer:string}}`、`{action:"decline"}` 或 `{action:"cancel"}`。非 `accept` 会取消当前 AskUser；空白 `answer` 无效。

### 5.8 当前未实现的 ACP 能力

以下方法或更新类型虽存在于 ACP SDK 1.3.0，但 `KindergartenAgent.createApp()` 当前没有注册或发送：

- Session：`session/delete`、`session/fork`、`session/set_mode`；
- NES：`nes/start`、`nes/suggest`、`nes/close` 及相关接受/拒绝通知；
- 文档通知：`document/did_open`、`document/did_change`、`document/did_close`、`document/did_save`、`document/did_focus`；
- Agent 输出：`plan`、`plan_update`、`plan_removed`、`available_commands_update`、`current_mode_update`、`config_option_update`、`session_info_update`、`usage_update`；
- Client 侧文件系统和终端反向能力未由当前 Agent 调用。

这里的“未实现”只描述当前项目注册状态，不表示 ACP 协议本身不支持。

## 6. 源码索引与维护规则

| 内容 | 当前权威源码 |
|---|---|
| HTTP 外壳、`/acp` 升级 | `apps/remote/src/server/http-server.ts` |
| Control API 包装、认证、CORS、错误 | `apps/remote/src/server/control-api.ts`、`apps/remote/src/server/api-problem.ts` |
| 路由 | `apps/remote/src/**/**-routes.ts` |
| 公共 HTTP 合同 | `packages/contracts/src/*.ts`、`packages/evaluation-contract/src/index.ts` |
| ACP 注册与 Session 行为 | `apps/remote/src/acp/kindergarten-agent.ts` |
| ACP 输出投影 | `apps/remote/src/acp/acp-output.ts` |
| 项目 ACP 扩展 | `packages/contracts/src/index.ts`、`session-binding.ts`、`session-resume.ts`、`turn-state.ts`、`execution-trace-stream.ts` |
| ACP 标准类型 | `@agentclientprotocol/sdk` 1.3.0 的生成类型 |

维护本文件时应重新执行三项核对：Control API `router.register` 总数与路径、`createApp()` 的 ACP `.onRequest/.onNotification` 注册、项目扩展通知的 `client.notify` 调用。不要仅凭 SDK 类型推断项目已实现能力。
