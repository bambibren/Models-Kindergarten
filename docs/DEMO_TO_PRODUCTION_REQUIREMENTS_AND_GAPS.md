# Demo 完整需求、交互效果与真实实现差距

> 主文档：[Model Kindergarten Demo 到真实产品实施 TRD](./DEMO_TO_PRODUCTION_TRD.md)  
> 数据与接口：[领域模型、数据与接口合同](./DEMO_TO_PRODUCTION_CONTRACTS.md)  
> 日期：2026-08-12

## 1. 目的与取证范围

本文只把 Demo 当作需求和交互效果证据，不把 Demo 的状态管理、假数据或分支方式当成实现方案。取证范围包括：

- `apps/web/src/demo/DemoApp.tsx` 实际注册的全部 `/demo` 路由；
- `apps/web/src/demo/pages`、`components`、`data`、`state` 中的页面、交互与演示状态；
- `apps/evaluation-web/src/demo` 中与 Context Lab 跨应用连接的页面；
- `apps/web/src`、`apps/remote/src`、`apps/evaluation-*`、`packages/*` 的非 Demo 实现；
- `docs/` 下与 Demo、ACP、MCP、Skill、Context、Token、Evaluation 和错误处理相关的设计与计划；
- 外部参考 TRD 及 appendix。

需求裁决规则：

1. 用户明确裁决高于 Demo：模型入园路由、小说真实创作流程、小说 MCP（Bearer Token）不进入本轮；小说卡片保留为不可点击的调研占位。评分实现三维人工注释量表 + Runtime 执行分的固定四维，不实现任何自动评分调用。
2. 实际路由和可操作效果高于只存在于文案中的设想。
3. `AGENTS.md` 的协议、安全和状态归属规则高于页面便利性。
4. 已有真实实现能满足同一需求时优先复用；若真实实现与需求冲突，则改变领域装配，不在 UI 里伪装。

## 2. 实际路由清单

### 2.1 Web Demo

实际由 `apps/web/src/demo/DemoApp.tsx` 注册：

| 路由 | 页面 | 本轮结论 |
| --- | --- | --- |
| `/demo/model-home` | 模型幼儿园首页 | 全量产品化，模型来源暂只读 |
| `/demo/session` | 会话与产物 | 全量产品化，小说伪流程剔除 |
| `/demo/context-lab` | 上下文实验室 | 全量产品化，运行与评分事实分离 |
| `/demo/agent-editor` | Agent 新建/编辑 | 全量产品化 |
| `/demo/me` | 我的资源 | 除模型入园/评分外全量产品化 |
| `/demo/mcp` | MCP 新建/详情 | 无认证 Remote MCP 产品化；Bearer 小说 MCP 留白 |

`apps/web/src/main.tsx` 只在命中上述精确路径时挂载 DemoApp；其他路径仍进入真实 Chat App。因此，Demo 并不是现有真实 App 的一组生产路由。

`/demo/model-admission` 已从 Demo 路由表和可见入口移除；保留在源码中的调研组件不属于可访问页面，也不进入本轮生产路由。

### 2.2 Evaluation Demo

Context Lab 的 Demo 将结果导航到：

- `http://127.0.0.1:5175/evaluation/demo/agent-comparison`

evaluation-web 已有真实 Turn 详情：

- `/evaluation/sessions/:sessionId/turns/:turnId`

目标新增：

- `/evaluation/experiments/:experimentId`

端口必须来自环境配置，不能复制 Demo 的 `5175` 常量。用户给出的 `5174` 是本地 Vite 实际占用端口，不是架构合同。

## 3. 全局产品语义

### 3.1 身份与资源归属

- 当前产品是本地单用户 Admin；页面不需要虚构登录、组织或角色切换。
- 所有 Agent、Session、Skill、MCP、Experiment、FileReference 都属于 `local-admin`，但记录保留 ownerId 以支持未来迁移。
- 用户可以在多个页面看到同一资源；所有页面必须读取同一个服务端事实源。

### 3.2 导航

- 顶部导航在首页、会话、Context Lab、Agent、我的、MCP 页面保持一致。
- 生产 URL 可刷新、前进/后退、直接打开；路由参数和 query 只保存资源引用，不保存完整业务对象。
- 页面跳转不得依赖另一个页面先写 `sessionStorage`。
- evaluation-web 地址由 route helper 生成，并携带资源 ID，不携带原始回答、上下文或 Secret。evaluation-web 是本仓库内专门显示实验/评测详情的另一个前端应用，不是第三方网站；新页面拿 ID 再向 Remote 查询数据。

### 3.3 三层状态，不混成一个状态机

页面同时会展示三种不同对象的状态，字段和组件必须分开命名：

1. **读取页面状态** `pageQueryState`：`loading | ready | empty | error`。它回答“这张页面的数据拿到了吗”；error 显示可操作提示、requestId 和重试，不暴露堆栈。
2. **当前按钮提交状态** `mutationState`：`idle | submitting | succeeded | failed`。它回答“刚才点保存/发送的这一次请求进行到哪了”；短暂成功提示结束后可回到 idle。
3. **服务端长任务状态** `jobState`：`queued | running | succeeded | failed | interrupted | cancelled`。它回答“即使页面关闭，安装/连接测试/实验运行在后端进行到哪了”。

例如打开 Skill 页时，页面查询可能已是 ready，安装按钮已从 submitting 回到 succeeded，但某个安装 Job 仍是 running；三者同时出现完全正常，不能共用一个 `status` 字段。

### 3.4 数据新鲜度

- Agent 编辑页直接提交完整表单；本地单用户首版以最后一次成功保存为准，不做 ETag、字段级冲突或多人协作合并 UI。
- MCP/Skill/Experiment 长任务用状态查询；页面重开后可以继续观察。
- ACP Update 只用于正在聊天的 Turn：当模型在该 Turn 内调用 `ensure_agent_skills` 时，Tool Call Update 可实时显示安装进度。MCP 管理页的连接测试/重连使用 Control API Job；实验每条 lane 的实时模型输出走其 ACP Session，但实验整体完成状态写入 ExperimentRecord。ACP 不是三类后台任务的通用 WebSocket。

## 4. 首页 `/`

### 4.1 用户目标

用户选择一个已可用模型和一个 Agent，编辑任务并进入真实会话；同时查看最近会话和可以开始的产品能力。

### 4.2 完整功能

| ID | 需求 | 交互效果 |
| --- | --- | --- |
| HOME-01 | 模型选择 | 下拉显示已配置 ModelStudent 的名称、provider/model 摘要和健康状态；不可用项禁选。不显示入园入口。 |
| HOME-02 | Agent 选择 | 下拉显示可用 Agent；支持进入新建/编辑。选择只发生在创建 Session 之前。 |
| HOME-03 | 可编辑任务 | 模板只填充 composer，不立即发送；用户可继续编辑。 |
| HOME-04 | 创建会话 | 点击发送后创建真实 ACP Session，持久绑定 modelStudentId 和 agentId，再导航到 `/sessions/:id`。 |
| HOME-05 | 网站开发模板 | 模板只是帮用户填入可编辑的提示词。只有用户消息明确包含有效 Skill 来源地址时，模型才可调用 `ensure_agent_skills`；模糊的“帮我设计网页”只能使用该 Agent 已绑定的 Skills，不能自行搜索、猜地址或安装。 |
| HOME-06 | Context Lab 入口 | 进入 fresh 模式，携带可选的当前 modelStudentId/agentId 引用。 |
| HOME-07 | 最近会话 | 服务端分页返回 purpose=`chat` 的最近会话；显示标题、Agent、模型、更新时间和状态。 |
| HOME-08 | 会话恢复 | 点击最近会话使用 ACP load/resume 语义打开，不重建会话。 |
| HOME-09 | 小说卡片 | 保留卡片并显示“功能调研中”，使用原生 disabled 语义且不可点击、不可填入提示词、不可进入假会话。 |
| HOME-10 | 模型评分摘要 | 没有已保存评分时显示“尚未评测”；有人工评分时可显示由服务端记录计算出的总分，不使用写死分数。 |

### 4.3 数据与事件

- 读取：`GET /model-students`、`GET /agents`、`GET /sessions?purpose=chat&limit=...`。
- 发送：ACP `session/new`，`_meta` 只携带 versioned SessionBinding，成功后 ACP `session/prompt`。协议字段 `mcpServers=[]` 的意思是“不允许浏览器为这个会话临时塞入一套 MCP 连接”；Agent 已绑定 MCP 的工具由 Remote Runtime 组装进模型请求的 `tools`，不是拼到 Message 的系统提示词。
- 首页模板是前端写死或由静态配置提供的“提示词快捷填充内容”，例如点击“网站开发”后把一段任务说明放进输入框；它不创建资源、不表示任务已完成，用户仍可修改后再发送。

### 4.4 验收

- 刷新首页后选择项和最近会话不丢失。
- 创建的 Session 在 Remote 重启后仍保存原 modelStudentId/agentId。
- 未选择可用模型或 Agent 时发送按钮禁用并解释原因。
- 任何文本变化都不会触发特定业务分支；网站开发能力由真实 tool call 决定。

## 5. 模型入园

本轮不注册 `/model-admission` 或 `/demo/model-admission`，也不显示入园按钮。其他页面只消费 Remote 已配置好的 ModelStudent 只读目录；provider Secret 写入、连接检测、体检、创建和编辑均等待后续独立 ADR/TRD。

## 6. Session `/sessions/:sessionId`

### 6.1 页面布局

- 顶部：产品导航、连接状态、当前 Session 的模型和 Agent 身份。
- 左侧：可折叠会话栏，含新会话、搜索/历史列表、当前项。
- 中央：稳定有序的聊天流、上下文摘要、工具调用、权限/问询、composer。
- 右侧：按需打开的 Artifact panel；支持关闭和鼠标/触控笔拖动分栏。首版去掉键盘调节、双击复位等附加交互，先保证拖动稳定。

### 6.2 会话与导航

| ID | 需求 | 交互效果 |
| --- | --- | --- |
| SES-01 | 加载会话 | 直接 URL 加载 Session；不存在、无权、已损坏分别显示明确错误。 |
| SES-02 | ACP 所有权 | 整个浏览器页面只有一个 AcpWebClient；组件不能建立第二连接。 |
| SES-03 | 历史语义 | load 全量重放；resume 零重放；UI 不人为补一份重复历史。 |
| SES-04 | 一 Turn 限制 | 活动 Prompt 时 composer/再次发送符合现有 PromptTurn 状态机，不并发第二 Turn。 |
| SES-05 | 新会话 | “新会话”返回首页或打开创建页，让用户先选模型/Agent 再创建真实 Session；不能只清空当前 UI。 |
| SES-06 | Agent 身份 | 只读显示 Session 创建时绑定的 Agent。会话页面没有选择器或改绑操作；编辑这个 Agent 的配置只影响后续 Turn。 |
| SES-07 | 模型身份 | 只读显示 Session 创建时绑定的模型。会话页面没有选择器或切换操作。 |

### 6.3 聊天流

| ID | 需求 | 交互效果 |
| --- | --- | --- |
| CHAT-01 | 稳定顺序 | 用户、assistant、thought、tool call 以 Remote 事件顺序稳定显示；流式 chunk 不重排已有卡片。 |
| CHAT-02 | 工具状态 | pending/in_progress/completed/failed 状态、标题、输入摘要、输出与位置保持一致。 |
| CHAT-03 | 权限 | write/run/其他危险工具继续走 ACP permission；页面显示等待、允许、拒绝。 |
| CHAT-04 | AskUser | 继续走 ACP elicitation；表单完成后返回当前 tool call，不另建 HTTP 问答接口。 |
| CHAT-05 | 上下文摘要 | 显示实际上下文源、截断、能力、provider raw input/usage；来自 Turn snapshot，不前端估算。 |
| CHAT-06 | 实验入口 | 已完成 Turn 可进入 `/context-lab?turnId=...`；流式/失败 Turn 不提供可运行入口。 |
| CHAT-07 | 错误 | 可恢复/不可恢复、provider/tool/MCP 错误统一投影；保留可复制 requestId。 |
| CHAT-08 | 取消 | ACP cancel 停止当前 Turn；已产生消息/工具记录按现有持久语义保留。 |

### 6.4 Skill 安装 Banner

- 只在当前 Turn 的 `ensure_agent_skills` tool call 期间出现。
- 展示 Batch 总状态和逐项状态：queued、validating、installing、ready、failed。
- 整批成功并完成 Agent 绑定后显示“已加入当前 Agent”；若部分失败则不绑定任何新增 Skill，并提供重试/打开 Skill 管理。
- 刷新页面后 Banner 可根据 tool entry 和 Job 状态恢复，不依赖定时器。
- 同 Turn 后续模型轮次必须真的看到 `activate_skill`/资源能力；需要新 generation 的能力快照。
- `ensure_agent_skills` 负责安装/复用并绑定；已经安装且绑定的 Skill 不必再次 ensure。需要把 Skill 完整说明加载到当前 Turn 时，模型调用现有的 `activate_skill`。这里没有名为 `active_skills` 的协议动作。
- 去重不能只看名称：相同规范化来源和相同 commit/hash 直接复用；相同来源已有版本默认跳过更新，只有用户明确要求“更新”才获取并校验新版本；同名不同来源视作不同对象并提示冲突，避免恶意同名覆盖。

### 6.5 MCP 在聊天中的边界

- 页面只展示本 Turn 实际可见/调用的 MCP 工具或资源，不投影整个 MCP 管理对象。
- Agent 未绑定、Installation 禁用/断开或 snapshot 不含的能力不能出现在 Tool definitions，调用时还要二次拒绝。
- 本产品的 MCP 由 Remote 统一保存、连接并按 Agent 授权。Browser 的 ACP `session/new.mcpServers` 因而只能传空数组；“非空列表”就是浏览器传了一个或多个临时 MCP server 配置，Remote 直接拒绝，防止绕开“我的 MCP → Agent 绑定”规则。
- MCP 管理入口跳到 `/mcps/:id`；聊天页面不编辑 URL、Secret 或能力白名单。

### 6.6 Artifact panel

| ID | 需求 | 交互效果 |
| --- | --- | --- |
| FILE-01 | 文件识别 | Tool result 中的 `mk-file://{id}` resource link 显示为产品内可打开文件。 |
| FILE-02 | Markdown | 使用安全 Markdown renderer，保留代码块和基本排版。 |
| FILE-03 | HTML | iframe sandbox 预览静态 HTML；无脚本权限、严格 CSP、外链受限。 |
| FILE-04 | 分栏 | 最小聊天宽度 300px、最小产物宽度 300px；鼠标/触控笔拖动稳定，跨过 iframe 或到达阈值时不抖动。首版无键盘调节、无双击复位。 |
| FILE-05 | 恢复 | 当前打开的 fileReferenceId 可放 URL/query 或无业务风险 UI 状态；刷新时重新鉴权读取。 |
| FILE-06 | 不支持类型 | 显示元数据和下载/查看限制，不尝试执行。 |

### 6.7 验收

- 首页创建的真实 Session 可完成普通问答、工具、权限和 AskUser。
- 刷新与 Remote 重启不产生重复消息或丢失 Session 身份。
- Skill 安装成功后的同一 Turn 下一轮有新能力；失败不污染 Agent。
- 文件链接不含绝对路径，其他 Session 无法读取。

## 7. Context Lab `/context-lab`

### 7.1 Fresh 模式

| ID | 需求 | 交互效果 |
| --- | --- | --- |
| LAB-F-01 | 初始输入 | Prompt 可编辑；可选择已有模型和 Agent。 |
| LAB-F-02 | A/B 初始一致 | A 与 B 从同一 Agent 当前策略创建独立草稿；未产生差异时运行禁用。 |
| LAB-F-03 | 可选 C | 最多三 lane；C 从选定 lane 复制后独立编辑，可删除。 |
| LAB-F-04 | 策略模块 | system、内置工具、MCP、Skills、history；memory 显示关闭。 |
| LAB-F-05 | 实际预览 | 服务端返回每 lane 实际模型输入片段、来源、截断和 token estimate；编辑后防抖刷新。 |
| LAB-F-06 | 差异摘要 | 明确显示哪个模块、哪些能力、哪条 system/history 策略不同。 |
| LAB-F-07 | 运行 | 保存 draft 后，为每个 lane 建立 experiment Session 并使用 ACP Prompt；显示逐 lane 状态。 |

### 7.2 History 模式

| ID | 需求 | 交互效果 |
| --- | --- | --- |
| LAB-H-01 | 入口 | 只接受 turnId；服务端解析 sessionId、prompt、模型和快照，不接受浏览器拼装历史。 |
| LAB-H-02 | 不可变事实 | 原 Prompt、原上下文、原回答、Agent 配置快照哈希、能力快照和 provider 输入均只读。 |
| LAB-H-03 | A 复用 | A 固定 `reuse_snapshot`，直接使用原始结果，不请求模型、不产生新 usage。 |
| LAB-H-04 | B/C 重跑 | 从原策略复制后修改，使用相同模型和 Prompt，在隔离 experiment Session 中运行。 |
| LAB-H-05 | 历史隔离 | 实验 Session 不出现在普通会话列表，不把实验消息写回原 Session。 |

### 7.3 策略编辑规则

- system：编辑 system prompt 文本；保留来源和长度限制。
- tools：从 Agent 已允许的内置工具中选择并设置权限；不能提交任意 JSON Schema。
- MCP：只能选择 owner 已安装且 ready/connected 的 MCP capability；服务端校验 snapshot generation。
- Skills：只能选择 ready SkillInstallation；服务端加载其规范内容。
- history：`none` 或 `recent_turns(maxTurns)`；token 截断仍由 ContextAssembler 决定。
- memory：只读 `off`。

### 7.4 运行与恢复

- Draft/Run 均有服务端 ID；prepare-run 会把启动瞬间的 variants/policy 复制到不可变 run records。
- 运行按钮使用 Idempotency-Key；双击不会创建重复 lane。
- 页面关闭后重新打开可读取 lane 状态；running lane 根据 ACP Session/Turn 事实恢复。
- 一个 lane 失败不取消其他 lane；结果页明确显示 partial failure。
- 运行完成后跳转 evaluation-web 的 experimentId 路由。

### 7.5 验收

- token 与 raw input 预览来自真实 serializer，不使用固定数字表。
- fresh 无差异不能运行；history A 永不发模型请求。
- B/C 使用正式 Runtime/Tool/Context 主链，且不污染聊天历史。
- B/C 产生的确实是真实 ACP Session/Turn，但标记 `purpose="experiment"`，只从 ExperimentRecord 访问，默认普通会话列表过滤掉它们；它们也不会追加到来源聊天 Session。
- 运行完成后可进入人工评分；评分不改变原回答、上下文和运行事实。

## 8. Agent Editor `/agents/new`、`/agents/:agentId`

### 8.1 基本信息

- 新建时要求名称；描述可选；system prompt 有长度限制。
- 编辑时加载服务端 record；保存完整表单，最后一次成功提交生效。
- Agent 为单一可变实体，没有 version/revision 选择器或协议字段。
- 已被 Session 使用的 Agent 可继续编辑；历史 Turn 通过 snapshot 保持可解释。

### 8.2 能力配置

| ID | 需求 | 交互效果 |
| --- | --- | --- |
| AG-01 | 内置工具 | 显示 Remote 支持的 built-in catalog；逐项启用并选择 permission。 |
| AG-02 | Skills | 只显示 ready Installation；可进入安装页；保存 installationId 列表。 |
| AG-03 | MCP | 选择 MCP Installation，并在其真实 snapshot 中选择工具/资源和权限。 |
| AG-04 | History | off 或 recent_turns/maxTurns；UI 解释对 token 和连续性的影响。 |
| AG-05 | Memory | disabled/off，说明未启用。 |
| AG-06 | 校验 | 悬空/禁用/过期 capability 在保存时拒绝或要求刷新，不静默保存。 |
| AG-07 | 保存冲突 | 本地单用户首版不做 ETag 和字段级差异；若以后支持多窗口/多人同时编辑，再单独引入版本冲突策略。 |

### 8.3 保存后语义

- 新 Session 可立即选择该 Agent。
- 已有 Session 的下一个 Turn读取新 Agent；当前正在运行的 Turn仍使用已经解析的 generation，除非结构化 capability change 触发同 Turn刷新。
- 首版没有 Agent 归档、删除或 Session 迁移。已有 Session 持续引用该 Agent，页面不会出现“迁移 Session”入口。

### 8.4 验收

- 保存/刷新不丢配置；Remote 重启后保持。
- 未安装 Skill 或未连接 MCP 不可伪装成可绑定。
- 任意浏览器输入都不能制造 Remote 未发现的 MCP tool definition。

## 9. “我的” `/me`

### 9.1 公共行为

- 顶部显示本地 Admin 资料和资源统计；统计来自服务端查询。
- tab 体现在 URL query 或子路由，可直接打开。
- 搜索、分页、排序由服务端执行；清空搜索恢复第一页。

### 9.2 Experiments

- 列表字段：名称、模式（fresh/history）、状态、模型、Agent、lane 数、来源 Turn、更新时间。
- 支持搜索、状态筛选、分页、打开原始对比。
- 保存标记是持久字段；删除首版可不提供，避免误删证据。
- 不显示模型分数、胜率或综合排名。

### 9.3 Agents

- 列表显示名称、描述、Skill/MCP/工具数量和更新时间。
- 支持新建、编辑；首版不提供归档、删除和 Session 迁移。

### 9.4 Models

- 只读显示当前已配置 ModelStudent、provider/model、健康状态和最后检查时间。
- “添加模型”“入园”隐藏；评分入口来自已完成实验，不在 Models 管理页修改模型连接。

### 9.5 MCPs

- 显示 name、URL host、transport、auth kind、state、capability 数、最后连接/错误。
- 支持打开详情和新建无认证 Remote MCP。
- Secret 不显示；Bearer 新建/更新留白。

### 9.6 Skills

- 显示 skillId、名称、版本/commit、source、state、安装时间和失败摘要。
- 支持 GitHub tree URL 或批准的本地来源安装，展示真实 Job。
- 只有 ready 项可用于 Agent；quarantined/failed 可重试或查看安全错误。

## 10. MCP `/mcps/new`、`/mcps/:mcpId`

### 10.1 新建流程

本轮只允许页面新建 `authKind="none"`。既有环境变量/Keychain Bearer 配置可作为只读 `externally_managed_bearer` 兼容导入，但页面不能创建、修改或显示 credentialRef。新建流程为：

1. 输入名称、HTTPS Streamable HTTP URL；开发模式允许 loopback HTTP。
2. 点击“测试连接”创建 McpTest Job。
3. Remote 执行 URL/网络策略、连接、initialize、tools/resources/prompts discovery。
4. 页面按 testId 查询 queued/testing/succeeded/failed，展示服务端 capability preview。
5. 测试成功后才能安装；安装引用 testId，Remote 重新校验测试未过期且 URL 未改变。
6. 创建 Installation 和初始 snapshot，Supervisor 建立受管理连接。

不能让页面直接提交“我发现了哪些工具”；capability preview 只是 Remote 测试结果。

### 10.2 详情流程

| ID | 需求 | 交互效果 |
| --- | --- | --- |
| MCP-01 | 状态 | installing/connecting/connected/degraded/disconnected/disabled/failed。 |
| MCP-02 | 能力 | 按 tools/resources/prompts 分组；显示名称、描述、schema 摘要和 snapshot 时间/generation。 |
| MCP-03 | 重连 | 触发 Supervisor 重连 Job；重复点击幂等；显示最后错误。 |
| MCP-04 | 刷新发现 | 连接成功后可刷新 capability snapshot；Agent 悬空 binding 明确标红。 |
| MCP-05 | 禁用/启用 | 禁用停止重连并使所有 Agent binding 运行时不可见；启用后重连。 |
| MCP-06 | 卸载 | 显示受影响 Agent；确认后在一个 UnitOfWork 中移除绑定、断开连接、标记卸载。 |
| MCP-07 | Bearer | UI、API 和 Secret 写入本轮均不实现。已有手工环境/Keychain 配置不在页面管理。 |

### 10.3 Agent 绑定语义

- 安装和连接不等于 Agent 可用。
- Agent binding 指向 installationId，并记录允许的 remote tool/resource 名称和权限。
- capability snapshot 更新后，已消失的名称成为 unresolved；不能自动把新发现工具加入 Agent。
- Runtime 每 Turn 按当前 Installation state、snapshot 和 Agent binding 构建实际 catalog；执行前再校验。

### 10.4 验收

- 新建无认证 Remote MCP 可经历真实测试、安装、连接和能力发现。
- Remote 重启后状态可恢复并重新连接。
- 禁用/卸载后下一 Turn 不再暴露工具；当前正在执行的调用按明确取消/完成策略结束。
- 页面、日志和 API 响应不出现 Secret。

## 11. Evaluation 实验对比与人工评分

### 11.1 本轮实现

- Experiment 名称、fresh/history、来源 Turn；
- A/B/C 回答，lane 状态和失败原因；
- 每 lane 的 Agent 配置快照哈希、模型、context sources、能力、raw provider input 摘要、usage、stop reason；
- 结构化差异视图和原始回答切换；
- 完整人工注释量表：理解、规划、输出三个 0～100 维度，保留各自的需求勾选/映射、Workflow 步骤标记和最终输出文本标注语义；
- 执行维度：根据同一 lane 的 Runtime Trace 和版本化 `ExecutionScorePolicy` 自动计算 0～100 分，这是确定性规则计算，不是自动评分模型调用；
- 四维固定为理解、规划、输出、执行，默认各占 25%；服务端计算四维总分、排名和并列规则，前端显示四轴雷达图与 winner；
- 保存标记和回到 Context Lab。

“人工注释量表”不是只有一个数字输入框，而是 Demo 里现有的三套人工操作：确认真实需求并观察各回答命中情况、对规划步骤做标注、对最终输出文本做标注。服务端按量表版本把这些 annotation facts 换算为理解/规划/输出三维分。

### 11.2 继续留白与指标边界

以下内容本轮不实现：

- 自动评分调用：再调用一个“裁判模型”读取 A/B/C 并替用户填写理解、规划或输出分；
- 裁判模型选择、提示词、校准集、置信度和人工复核工作流。

Runtime metrics 必须参与四维评分中的“执行”维度。首版输入至少包括：是否正常完成、Tool 成功率、错误数、权限违规数、重复 Tool 调用、首 Token 延迟和总耗时。评分必须引用版本化 `ExecutionScorePolicy` 和实验内共同基线：完成、安全性与错误有固定惩罚；时延只在同实验相同模型/环境的 lanes 间归一化。Rounds、Tool Calls、Context/Output Tokens 继续显示，但没有明确好坏方向时不直接扣分。这样 Runtime 事实会真正进入总分和雷达图，同时避免武断地把“token 少”当成“执行好”。

总分规则固定为 `round((理解分 + 规划分 + 输出分 + 执行分) / 4)`。三个人工维度全部完成后才产生 total/ranking/winner；未完成时显示“待完成标注”，不得默认 100 分。并列最高分显示并列 winner。

### 11.3 验收

- 结果来自 ExperimentRepository，不是页面 `useState`。
- 刷新、跨应用打开、Remote 重启后仍可查看。
- A reuse lane 清楚标记“原始结果”，usage 不重复计算。
- partial failure 可查看成功 lane；只有满足量表的可比较 lane 才参与排名，不生成虚假胜负。
- 人工 annotation facts 和 Runtime 执行分刷新后不丢失；四维总分、雷达图、排名和 winner 均由保存的 scorecard 重建，不由前端写死。

## 12. Demo 跨页状态与生产替代

| Demo 方式 | 表达的真实需求 | 生产替代 |
| --- | --- | --- |
| `sessionStorage` 保存选择 | 页面间共享当前资源 | URL 中放 ID；服务端 Repository 保存资源 |
| `sessionStorage` 保存 Agent/MCP/Skill | 资源可跨页管理 | Agent/Installation Stores；最后一次成功保存生效 |
| prompt 文本包含特定 URL | 用户明确授权从这些来源安装 Skill | Remote 校验 URL 来自当前用户消息后，模型才可调用 `ensure_agent_skills`；无 URL 时只用现有 Skills |
| `setTimeout` 推进安装/连接 | 用户需要可见进度 | 持久 Job/状态机 + polling/ACP projection |
| 写死聊天消息/工具结果 | 展示任务完成体验 | 正式 ACP Prompt、ToolRuntime、Provider 输出 |
| 写死 token 数 | 解释策略开销 | ContextAssembler + Provider serializer preview |
| 写死 5175 | 跨应用结果导航 | 环境配置 + route helper |
| 前端过滤 MCP tool | Agent 只看绑定能力 | Remote resolver + 调用前二次授权 |
| iframe 内存字符串 | 任务产生文件并可在右侧面板查看 | 每个会话独立文件目录 + 随机 FileReference ID；点击后按 ID 安全读取 HTML/Markdown 预览 |
| evaluation 页面内 `useState` 保存 | 实验结果可留存 | ExperimentRepository |

## 13. 非 Demo 真实实现盘点

### 13.1 已有可直接复用

| 能力 | 代码证据 | 复用结论 |
| --- | --- | --- |
| ACP Session 生命周期 | `apps/remote/src/acp/kindergarten-agent.ts` | 保留协议行为和单 Turn 不变量，扩展绑定解析 |
| 稳定流式聊天 | `apps/web/src/chat/chat-reducer.ts` | 保留 reducer，增加按 sessionId 的 update router |
| Permission/Elicitation | Remote ACP + Web ACP Client | 原样复用，不改走 HTTP |
| 模型流和工具循环 | `model/ollama-provider.ts`、`runtime/agent-runner.ts` | 抽出 TurnScope/Resolver，不复制执行器 |
| Context disclosure | `context/context-assembler.ts`、Context Summary UI | 扩展为持久 Turn snapshot 和预览服务 |
| Tool ledger/observation | AgentRunner、runtime-observation | 保留，增加 capability generation |
| File path 防逃逸 | `tools/file-sandbox.ts` | 演进为 session-scoped，并新增 FileReference |
| MCP 连接/发现/调用 | `mcp/*` | 抽为 per-installation Supervisor，保留网络策略和 connector |
| Skill 验证/隔离安装 | `skills/*` | 包装为统一 InstallationService/Job，保留 Validator |
| Turn 评测基础事实 | evaluation contracts/service/web | 保持原始事实；由版本化 ExecutionScorePolicy 合成四维中的执行分 |

### 13.2 Responses Provider 启用前门禁

`apps/remote/src/model/responses-api-provider.ts` 已是非 Demo 的协议雏形，但本轮不会接入 ModelStudent resolver。后续模型入园调研若决定启用它，必须先满足以下确定性要求：

- 多个 function call 即使完成事件逆序到达，也按 Responses `output_index` 稳定交给 Runtime；不能让网络事件完成顺序改变工具展示、assistant toolCalls 或下一轮 `function_call_output` 对应关系。
- `response.function_call_arguments.done`/`response.output_item.done` 只完成单个 output item；整个模型轮次的 finish、usage 和最终状态以 `response.completed`、`response.incomplete`、`response.cancelled`、`response.failed` 等正式终态为准。
- `[DONE]` 若兼容服务发送，只可作为传输结束提示；它不能代替缺失的正式终态。正式终态缺失时返回 `invalid_model_response`，不能伪造 stop 或 usage。
- 完成态 function call 必须有稳定 `output_index`、`call_id`、`name`，且 arguments 必须是 JSON object；非法上游响应不得静默丢调用。
- HTTP 错误正文、`response.failed` 和 SSE `error` 的 message 都必须通过同一 Secret redaction，再进入 PublicError、日志或 UI。

这些是协议正确性与安全门禁，不代表模型入园已经纳入本轮范围。

### 13.3 不能直接复用为产品事实

- `apps/remote/src/index.ts` 的全局 ModelStudent、全局 Agent prompt、全局 MCP allowlist、全局 Skill allowed IDs；
- `McpClientManager.initialize()` 的启动时一次性快照；
- `SkillRegistry.initialize()` 后没有公开 refresh 的冻结状态；
- `RuntimeCapabilityCatalog` 构造时固定 definitions；
- Session V3 缺少绑定和 Turn snapshot；
- `write_file` 返回绝对 sandbox location 而不是文件引用；
- 真实 Web 只有单页 chat，无生产资源管理；
- evaluation comparison Demo 的评分和保存都只是浏览器内存。

## 14. 逐项差距矩阵

状态说明：`已有`=真实链已满足；`部分`=底层存在但领域装配不满足；`缺失`=没有真实实现；`留白`=本轮明确不实现。

| ID | 需求 | Demo | 非 Demo 现状 | 状态 | 目标改造 |
| --- | --- | --- | --- | --- | --- |
| G-01 | 生产多路由 | 有七个 demo route | 真实 Web 只有 Chat App | 缺失 | Router + App Shell + feature routes |
| G-02 | 唯一 ACP owner | Demo 不连 ACP | App 一个 client | 部分 | Provider 化并覆盖所有生产页面 |
| G-03 | 已有模型选择 | 写死模型列表 | index 一个 env ModelStudent | 部分 | 只读 ModelStudentCatalog；入园留白 |
| G-04 | Agent 选择 | sessionStorage | 无 Agent domain | 缺失 | AgentRepository/Service；创建 Session 时固化绑定 |
| G-05 | Session 模型绑定 | 视觉展示 | Session V3 无字段 | 缺失 | Session V4 modelStudentId |
| G-06 | Session Agent 绑定 | 视觉展示 | Session V3 无字段 | 缺失 | Session V4 agentId |
| G-07 | 最近会话 | mock | ACP list real | 部分 | enrich summary、purpose filter、分页 |
| G-08 | load/resume | 假列表 | 已实现且有测试 | 已有 | 保持不变量 |
| G-09 | Prompt streaming | 写死片段 | ACP/Provider real | 已有 | 接入生产 Session 页面 |
| G-10 | tool order | 写死卡片 | reducer + tests | 已有 | 回归保护 |
| G-11 | permission | Demo 效果 | ACP real | 已有 | 原样复用 |
| G-12 | AskUser | Demo 效果 | ACP real | 已有 | 原样复用 |
| G-13 | Agent 内置工具策略 | 控件 | 全局 ToolRegistry | 缺失 | Agent binding + Resolver |
| G-14 | Agent Skill 绑定 | sessionStorage | 全局 allowed IDs | 缺失 | Installation IDs in Agent |
| G-15 | Agent MCP 绑定 | 前端投影 | 单个 config allowlist | 缺失 | per-Agent capability bindings |
| G-16 | history policy | 控件 | ContextAssembler 固定 maxMessages | 部分 | per-Agent history policy |
| G-17 | memory | 占位控件 | 无 memory domain | 留白 | 仅 `off` |
| G-18 | Agent 保存 | 无 | 无 Store | 缺失 | 单进程串行写；最后一次成功提交生效 |
| G-19 | Skill 手动安装 | 定时器 | CLI installer | 部分 | Control Job + shared service |
| G-20 | 对话 Skill 安装 | 假 tool flow | 无 ensure tool | 缺失 | scoped `ensure_agent_skills` |
| G-21 | 同 Turn 能力刷新 | 假完成 | Turn 开始冻结 | 缺失 | structured effect + re-resolve |
| G-22 | Skill 进度恢复 | sessionStorage | 无 Job store | 缺失 | persistent Batch/Items |
| G-23 | MCP 无认证安装 | 定时器 | config file + initialize | 部分 | Test Job + Installation Service |
| G-24 | MCP 连接状态 | 假状态 | snapshot at startup | 部分 | Connection Supervisor |
| G-25 | MCP 重连 | 按钮假动作 | 无管理方法 | 缺失 | reconnect operation/idempotency |
| G-26 | MCP 禁用 | 本地开关 | 无生命周期 | 缺失 | persisted state + stop reconnect |
| G-27 | MCP 卸载 | 调 sessionStorage | 无 UnitOfWork | 缺失 | cascade Agent bindings atomically |
| G-28 | MCP discovery | mock | real connector | 部分 | persist snapshots/generation |
| G-29 | MCP 运行时授权 | 前端过滤 | provider 全局 allowlist | 部分 | per-Turn filter + execution recheck |
| G-30 | Bearer UI/小说 MCP | mock tail | secret read only | 留白 | 后续研究，不加写接口 |
| G-31 | Context fresh draft | 本地 state | 无 domain | 缺失 | ExperimentDraft Store/API |
| G-32 | Context history source | mock turn | Context Summary only | 部分 | immutable TurnExecutionRecord |
| G-33 | A reuse snapshot | 写死 lane | 无实验 | 缺失 | reference original result, no rerun |
| G-34 | B/C 真执行 | setTimeout | 无 orchestrator | 缺失 | ACP experiment Sessions |
| G-35 | context token preview | 固定 map | provider serializer exists | 部分 | server preview/hash cache |
| G-36 | raw provider input | mock/摘要 | Context Summary real | 部分 | persist/sanitize per Turn/lane |
| G-37 | 实验恢复 | sessionStorage | 无 Store | 缺失 | Experiment/Run persisted states |
| G-38 | 原始对比 | mock | demo-only component | 缺失 | production read-only result route |
| G-39 | 实验保存 | useState | 无持久字段 | 缺失 | savedAt/savedBy update |
| G-40 | 实验评分 | Demo 三维人工注释 + Runtime 执行分 | 仅基础 metrics | 部分 | annotation facts、ExecutionScorePolicy、固定四维、总分、雷达、排名、winner；不做自动评分调用 |
| G-41 | write_file | 假产物 | real write + absolute location | 部分 | session sandbox + FileReference |
| G-42 | ACP resource_link | 内存对象 |外链 renderer | 部分 | tool content emits opaque link |
| G-43 | 内部预览 | iframe string | external new tab | 缺失 | File API + safe preview panel |
| G-44 | 分栏交互 | 已完整 | 无真实 Artifact panel | 部分 | 提取纯 UI，接真实 file ID |
| G-45 | Me experiments | mock/search | 无 experiment list | 缺失 | server pagination |
| G-46 | Me agents | sessionStorage | 无 Store | 缺失 | Agent list/service |
| G-47 | Me models | mock | env singleton | 部分 | read-only catalog |
| G-48 | Me MCPs | sessionStorage | config singleton | 部分 | Installation list |
| G-49 | Me Skills | timer/list | registry real | 部分 | Installation projection + Job |
| G-50 | 错误合同 | 局部文案 | runtime error mapping | 部分 | ProblemDetail + requestId |
| G-51 | 本地 API 安全 | 不涉及 | 只有 health/acp | 缺失 | loopback + Origin allowlist |
| G-52 | 数据迁移 | 不涉及 | Session V3/global configs | 缺失 | versioned migrators/importers |
| G-53 | 可观测性 | 视觉状态 | Turn observation real | 部分 | domain operation events/metrics |
| G-54 | 小说创作 | 写死会话 | 无领域实现 | 留白 | 后续研究 |
| G-55 | 模型入园 | Demo 页面 | 方案/Provider 雏形 | 留白 | 后续研究 |
| G-56 | Responses Provider 启用门禁 | Demo 仅模拟 | Adapter 雏形尚未接 resolver | 留白 | 模型入园阶段先验证正式终态、逆序并行工具、严格调用校验和 Secret 脱敏 |

## 15. 功能优先级与依赖

### P0：基础事实与安全边界

- Contracts、LocalPrincipal、Control API envelope；
- AgentRepository、Session V4、Turn snapshot；
- RuntimeCapabilityResolver、session-scoped FileSandbox；
- 数据迁移和 feature flags。

### P1：核心可用链

- 生产路由、首页→Session；
- Agent 编辑；
- Skill 安装/同 Turn refresh；
- 无认证 MCP 管理和 Agent binding；
- FileReference 和 Artifact 预览。

### P2：实验与资源中心

- Context Preview/Draft；
- history/fresh 实验 ACP lane；
- 原始对比和实验列表；
- Me 全部真实 tab。

### P3：收口

- 迁移、错误/可观测性、安全回归、性能与 E2E；
- 逐路由关闭 Demo fallback。

调研留白不属于 P0～P3。

## 16. 总体验收清单

- [ ] 七个 Demo 入口都有明确生产映射或研究留白，未遗漏暗链。
- [ ] 生产业务状态不读取 Demo `sessionStorage` key。
- [ ] 生产异步流程不使用 UI timer 伪造服务端进度。
- [ ] 生产功能不按 Prompt 文本、URL 字符串或模板名称分支。
- [ ] 所有 Agent/Skill/MCP/Experiment 更新都可刷新恢复并处理并发。
- [ ] 每个 Session 和 Turn 都可解释实际模型、Agent、能力与上下文。
- [ ] Skill/MCP 只有通过服务端安装、绑定和运行时校验才对模型可见。
- [ ] Context Lab 使用真实 serializer 和 ACP Runtime；历史 A 不重跑。
- [ ] Artifact 使用 opaque FileReference，无法跨 Session 或通过路径越权。
- [ ] evaluation 生产页的三维人工注释和 Runtime 执行分可持久恢复；四维总分、雷达图、排名和 winner 来自服务端 scorecard，不来自写死数据；自动评分入口/API 缺席。
- [ ] 模型入园、自动评分、小说、Bearer 小说 MCP 明确处于 capability disabled/研究态；人工评分合同和页面属于本轮。
- [ ] 若未来打开 Responses Provider，必须先通过 G-56 门禁；不能把 `[DONE]` 兜底当成协议成功。
- [ ] 现有 ACP load/resume、PromptTurn、Permission、Elicitation、tool order 测试全部保持通过。
