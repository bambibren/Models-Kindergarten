# Models Kindergarten V1 Remote MCP 设计与 Demo 规格

> 状态：前端功能 Demo 已实现；真实数据库、凭据保管、MCP Client 与模型调用尚未实现。
>
> V1 决策：用户只能添加远程 `Streamable HTTP` MCP。不提供“来源类型”选择，不做 MCP 市场、stdio 安装器或浏览器本地 MCP。

## 1. 核心结论

MCP 的“安装”“连接”和“允许 Agent 调用”是三个独立状态：

1. **安装到账号**：Admin 保存一个远程 MCP 地址及认证配置，形成 `McpInstallation`。
2. **连接可用**：服务端使用该配置完成 `initialize` 与能力发现，状态为 `ready`。
3. **授权给 Agent**：某个 Agent 的 MCP 模块显式保存 `mcpInstallationIds`。只有这些 MCP 能力才进入本轮模型 Tool Registry。

因此，“我的 MCPs”不是模型的全局工具箱。它只是 Admin 可分配资源的账号库；Agent 配置才是运行时权限边界。

## 2. 页面与组件关系

```text
/demo/me?tab=mcps
  我的 MCPs
  ├─ + 添加远程 MCP ───────────────┐
  └─ MCP 详情 / 状态 / Agent 使用关系 │
                                      ▼
/demo/mcp?mode=create          /demo/mcp?mcpId=...
  连接配置                       连接详情
  认证配置                       重新连接 / 更新 Token
  测试连接                       启用 / 停用 / 卸载
  能力发现                       能力快照
  确认安装

/demo/agent-editor
  Agent 身份
  上下文策略
  ├─ 系统提示
  ├─ 内置 Tools
  ├─ MCP 能力 ◀── 只列出“我的 MCPs”
  ├─ Skills
  ├─ 记忆
  └─ 历史策略

/demo/session
  选择 Agent
  ├─ 上下文提要：本轮实际注入的 MCP Tool Schema 摘要
  ├─ MCP 能力边界：已注册与被排除数量
  ├─ Tool Call：服务名、toolCallId、输入、输出、状态
  └─ Assistant：说明只使用当前 Agent 已授权能力
```

### Demo 组件树

```text
DemoApp
├─ MePage
│  └─ McpPanel
├─ McpEditorPage
│  ├─ McpCreate
│  ├─ McpDetail
│  └─ CapabilityDiscovery
├─ AgentEditorPage
│  └─ AgentStrategyFields
│     └─ McpModuleEditor
└─ SessionDemoPage
   └─ DemoChatStream
      ├─ ContextItem
      ├─ McpBoundaryItem
      └─ McpToolCallItem
```

## 3. “我的 MCPs”交互

### 3.1 列表

列表每项展示：

- MCP 名称与用途；
- Streamable HTTP URL；
- 连接状态；
- Tool 数量；
- `无需鉴权` 或 `Bearer`；
- 进入详情的入口。

右上角只有“添加远程 MCP”。不出现来源选择，因为 V1 的用户新增来源只有远程 HTTP。

### 3.2 添加流程

```text
填写名称和 HTTPS /mcp 地址
        ↓
选择 无鉴权 / Bearer Token
        ↓
测试连接
        ↓
initialize + tools/list + resources/list + prompts/list
        ↓
展示能力发现结果
        ↓
确认安装到 Admin
        ↓
回到“我的 MCPs”
        ↓
用户前往 Agent 配置显式勾选
```

约束：

- 只接受 HTTPS Streamable HTTP 地址；
- 测试失败不能安装；
- 修改 URL、认证方式或 Token 后，原测试结果立即失效；
- Token 输入只在提交和验证时出现，不在后续页面回显原文；
- Demo 只保存凭据尾号提示，不保存 Token 原文。

### 3.3 详情页

详情页支持：

- 查看连接地址、认证类型、能力数量、最近检测时间；
- 重新连接并刷新能力快照；
- Bearer MCP 更新 Token：新 Token 验证成功后原子替换；
- 停用和重新启用；
- 查看当前绑定它的 Agent；
- 卸载。

语义：

- **重新连接**不是重新安装。它重新握手并刷新能力快照；
- **停用**保留配置和 Agent 选择，但运行时不注册能力；
- **卸载**删除账号配置、加密凭据和 Agent 绑定；
- 远程 HTTP 通常是按请求建立或复用会话，“已连接”表示配置最近验证可用，不承诺永远保持一个 TCP 连接。

## 4. 账号与凭据

### 4.1 归属

```text
Account(Admin)
├─ Models
├─ Agents
├─ MCP Installations
│  └─ Encrypted Credential
└─ Skills

Login Session / Session ID
└─ 只证明当前浏览器请求属于 Admin
```

MCP Token 跟随 Admin 账号，而不是跟随某个浏览器或某次登录。Admin 在多个设备登录时看到相同的 MCP 安装与授权状态。

### 4.2 Bearer Token 最小安全方案

1. 用户从话本地图生成专用、可撤销、最小权限的 MCP Access Token；
2. 浏览器通过 HTTPS 把 Token 提交给 MK 服务端；
3. MK 立即验证；
4. 验证成功后使用服务端 KMS/主密钥进行信封加密，密文绑定 `accountId + mcpInstallationId`；
5. 浏览器之后只得到配置 ID、状态和尾号提示；
6. 运行时服务端解密并向远程 MCP 添加 `Authorization: Bearer ...`；
7. 更新 Token 时先验证新 Token，再原子替换；卸载时删除密文。

HTTPS 保护 Token 在网络传输中的机密性；服务端加密保护数据库备份或数据层泄露。二者解决的是不同威胁。后端为了代表用户调用 MCP，必然在调用瞬间能够获得明文 Token。

## 5. 领域数据结构

```ts
type McpConnectionState =
  | "ready"
  | "reconnecting"
  | "auth_required"
  | "failed"
  | "disabled";

interface McpInstallation {
  id: string;
  accountId: string;
  name: string;
  description: string;
  transport: "streamable_http";
  url: string;
  authKind: "none" | "bearer";
  credentialId?: string;          // 只指向服务端加密凭据
  connectionState: McpConnectionState;
  capabilitySnapshot: McpCapability[];
  capabilityRevision: string;
  lastCheckedAt: number;
}

interface Agent {
  id: string;
  accountId: string;
  name: string;
  contextPolicy: {
    systemPrompt: string;
    builtinToolIds: string[];
    mcpInstallationIds: string[]; // MCP allowlist
    skillIds: string[];
    memoryPolicy: object;
    historyPolicy: object;
  };
}

interface McpToolBinding {
  capabilityId: string;           // 稳定内部 ID
  mcpInstallationId: string;
  remoteToolName: string;
  modelToolName: string;          // 必要时命名空间化
  inputSchema: object;
  capabilityRevision: string;
}
```

推荐模型工具名按服务命名空间化，例如 `deepwiki__ask_question`，避免两个 MCP 都声明 `search` 时冲突。UI 可继续显示友好名称。

## 6. 运行时严格授权算法

```text
session/prompt(agentId)
        ↓
读取 Agent 当前配置
        ↓
读取 Agent.mcpInstallationIds
        ↓
按 accountId 校验所有权
        ↓
过滤 state != ready 的 MCP
        ↓
读取能力快照，生成 namespaced Tool Schema
        ↓
与内置 Tools 合并为本轮 Tool Registry
        ↓
只把这个 Registry 发送给模型
        ↓
模型产生 tool_call
        ↓
执行器按 capabilityId + Agent allowlist 再校验一次
        ↓
调用对应远程 MCP
        ↓
把 ACP tool_call / tool_call_update 投影到聊天消息流
```

必须同时有两道防线：

1. **模型可见性**：未配置 MCP 的 Tool Schema 根本不发给模型；
2. **执行授权**：即使收到伪造、过期或模型幻觉的 tool name，执行器仍按本轮 Registry 拒绝。

所以“没配置的不能调用”不能只靠提示词，也不能只靠前端隐藏复选框。

### 伪代码

```ts
const agent = await agentRepo.getOwned(accountId, agentId);
const installations = await mcpRepo.listOwnedByIds(
  accountId,
  agent.contextPolicy.mcpInstallationIds,
);

const allowed = installations.filter((mcp) => mcp.connectionState === "ready");
const registry = toolRegistry.build(agent, allowed);

const response = model.prompt({ messages, tools: registry.modelSchemas });

for await (const call of response.toolCalls) {
  const binding = registry.byModelToolName.get(call.name);
  if (!binding) throw new ToolNotAllowedError(call.name);
  const result = await mcpRuntime.call(binding, call.arguments);
  yield projectAcpToolUpdate(call, binding, result);
}
```

## 7. 消息流投影

MCP 不改变既定的“稳定历史 + `streamingEntries`”设计。

```ts
interface McpBoundaryEntry {
  type: "mcp_boundary";
  agentId: string;
  allowedMcps: Array<{ id: string; name: string; toolCount: number }>;
  excludedCount: number;
}

interface McpToolEntry {
  type: "tool";
  id: string;                     // UI item ID
  toolCallId: string;             // 聚合乱序 update 的主键
  source: "mcp";
  mcpInstallationId: string;
  serverName: string;
  remoteToolName: string;
  status: "in_progress" | "completed" | "failed";
  input: unknown;
  output?: unknown;
}
```

归约规则：

1. 收到 Tool Call 开始事件时，按首次出现位置向 `streamingEntries` 插入；
2. 后续输入增量、输出增量和完成事件一律按 `toolCallId` 更新原 Item；
3. B 工具可以先于 A 完成，但仍留在 B 首次出现的位置；
4. 单个 Item 可以先完成，不单独挪入历史；
5. 原始 `session/prompt` 返回最终 `PromptResponse` 后，将本轮全部 `streamingEntries` 原顺序提交到稳定 `entries`；
6. UI 展示 `serverName + toolCallId + input + output + status`，便于证明调用来源与聚合正确；
7. 上下文提要里的 MCP 项展示本轮实际发送给模型适配层的 Schema 摘要，而不是账号安装总表。

## 8. Demo 已实现的状态机

```text
添加：idle → testing → success → installed(ready)
                     ↘ failed → 修改配置 → idle

详情：ready ↔ disabled
       ready → reconnecting → ready / failed
       auth_required → update_token → ready / failed
       any → uninstall → removed
```

前端 Demo 使用 `sessionStorage` 保存：

- 用户添加的 MCP 元数据；
- 卸载的写死示例 ID；
- Agent 配置；
- 凭据仅保存尾号提示，不保存原文。

这只是为了让 Demo 在当前标签会话中可交互，不代表生产存储方案。

## 9. Demo 与真实开发边界

### 本次已经完成

- “我的 MCPs”专用列表与添加入口；
- 远程 HTTP 配置、无鉴权/Bearer、连接测试、能力发现；
- MCP 详情、重连、更新 Token、启停、卸载；
- Agent 配置中的 MCP allowlist；
- 勾选变化驱动 Token 估算；
- 会话页切换 Agent，并按 Agent 配置过滤 MCP 调用；
- 消息流显示 MCP 能力边界与调用来源；
- 未授权 MCP Tool Item 从 Demo 投影中消失；
- 状态与过滤算法单元测试。

### 后续真实开发才实现

- 数据库账号、登录与多点会话；
- 密钥管理、Token 加密与审计；
- SSRF 防护、域名/IP allow/deny、超时和响应大小限制；
- 真正的 MCP Streamable HTTP Client；
- OAuth 动态客户端注册或第三方授权流程；
- MCP 能力快照版本和 schema 变更处理；
- Tool 风险分级、写操作确认和审批；
- ACP 真实消息更新、断线恢复与错误码；
- 计费、速率限制和账号级配额。

## 10. 后续 API 草案

```text
GET    /api/me/mcps
POST   /api/me/mcps/test
POST   /api/me/mcps
GET    /api/me/mcps/:id
POST   /api/me/mcps/:id/reconnect
PUT    /api/me/mcps/:id/credential
PATCH  /api/me/mcps/:id/state
DELETE /api/me/mcps/:id

GET    /api/me/agents/:id
PUT    /api/me/agents/:id
GET    /api/me/agents/:id/resolved-tools
```

`POST /test` 应返回一次性测试结果或短期 `testId`，不持久化 Token。`POST /mcps` 在确认安装时使用已验证的短期结果落库；生产实现不应由前端提交伪造的 capability snapshot。

## 11. 验收标准

1. MCP 添加页没有来源选择，且只描述 Streamable HTTP；
2. 未测试成功时，“确认安装”不可用；
3. Bearer Token 后续不回显原文；
4. 安装 MCP 后不会自动修改任何 Agent；
5. Agent MCP 模块只显示 Admin 已安装列表，连接不可用项不可勾选；
6. 取消 MCP 勾选后该模块 Token 估算动态变化；
7. 会话切换到“短上下文 Agent”后，MCP 边界显示 0 个，MCP Tool Call 不出现；
8. 切回“默认 Agent”后，只出现 DeepWiki 与话本地图的调用；
9. MCP 详情能展示实际绑定它的 Agent；
10. 卸载后列表不再出现该项，运行时也不能注册其能力；
11. 前端类型检查、单元测试和生产构建通过。
