# Models Kindergarten 权限模型与公开 Artifact 访问设计

> 日期：2026-09-07  
> 状态：当前工作区已实现，尚未发布到生产环境

## 1. 结论

- 当前系统**不是 RBAC**：没有 Role、User-Role、Role-Permission 数据模型。
- 当前系统也**不是通用 ABAC**：虽然代码会判断 `ownerId`、请求方法、Artifact 状态、Agent 能力等属性，但没有统一策略语言或独立策略决策引擎。
- 准确分类是：**最小混合权限模型**。
  - 普通业务：登录身份 + `ownerId` 资源隔离。
  - Agent：owner 隔离 + 能力绑定 + `allow | ask | deny` + Tool 沙箱。
  - 公开 Artifact：`active` 状态 + opaque ID 的能力链接。
- 本次实现后，任何人访问 `/artifacts/:artifactId` 均无需登录；所有既有和新增的 `active` Artifact 都可凭链接读取。
- 归档、恢复、内部元数据和 Agent 引用仍只允许 owner 操作。

## 2. 当前权限总架构

```text
Browser
├─ 普通页面
│  └─ AuthGate：检查登录、负责页面跳转；不是服务端安全边界
├─ 公开 Artifact 页面 /artifacts/:id
│  └─ PublicArtifactPage：不挂 AuthGate
└─ Agent 会话
   └─ 官方 ACP WebSocket /acp

RemoteServer
├─ HTTP 第一层入口门禁
│  ├─ 普通请求：解析 mk_session，失败返回 401
│  └─ 明确公开请求：仅白名单路径和方法可跳过登录
├─ ControlApi 第二层入口门禁
│  ├─ 写请求：OriginPolicy 校验 Origin
│  ├─ 普通请求：再次解析 Principal
│  └─ 公开请求：使用相同公开 Artifact 判定函数
├─ Route / Service 对象级授权
│  ├─ 普通资源：resource.ownerId == principal.principalId
│  └─ 公开 Artifact：artifact.state == active
└─ Repository / Blob Store

ACP Agent 链路
RemoteServer.upgrade 登录校验
  → createAgent(principal)，固定 principalId
  → KindergartenAgent 校验 Session owner
  → RuntimeCapabilityResolver 校验 Agent、Model、Skill、MCP owner/状态
  → ToolRegistry 只暴露已启用能力并复核参数/权限
  → PermissionGate 执行 allow / ask / deny
  → ToolRuntime
  → FileSandbox / ProcessSandbox / 网络策略 / Tool Handler
```

关键点：系统没有“一个函数包办全部授权”。统一入口在 `RemoteServer` 和 `ControlApi`，具体资源归属必须由 Service 再校验。前端 `AuthGate` 只改善交互，不能代替服务端授权。

## 3. Gate 与校验内容

| 层级 | 位置 | 校验内容 | 失败结果 |
|---|---|---|---|
| 页面 Gate | `apps/web/src/product/AuthGate.tsx` | 是否存在有效登录 Session | 跳转登录页 |
| HTTP Gate | `apps/remote/src/server/http-server.ts` | Cookie Session；是否属于公开路径和 GET 方法 | 401 |
| Control Gate | `apps/remote/src/server/control-api.ts` | 路由、Principal、写请求 Origin、并发与 JSON 大小 | 401 / 403 / 404 / 503 |
| 对象 Gate | 各业务 Service | `ownerId` 是否匹配；资源状态和引用是否合法 | 通常返回 404，隐藏资源是否存在 |
| Agent 能力 Gate | `runtime-capability-resolver.ts`、`tool-registry.ts` | Agent 是否拥有该 Tool/Skill/MCP，能力是否启用 | 不暴露或拒绝调用 |
| Tool 权限 Gate | `permission-gate.ts`、`tool-runtime.ts` | `allow | ask | deny`；`ask` 通过 ACP 请求用户确认 | 拒绝执行 |
| 执行沙箱 | `sandbox.ts` 等 | 路径、符号链接、大小、进程、网络等边界 | Tool 失败 |

公开 Artifact 的两层 HTTP Gate 共用 `apps/remote/src/server/public-artifact-request.ts`，避免外层放行、内层仍要求登录，或误把写请求开放。

## 4. 普通业务权限

| 资源 | 读取 | 写入 |
|---|---|---|
| Agent、Session、Turn | 登录 + owner | 登录 + Origin + owner |
| ModelStudent、入园测试 | 登录 + owner | 登录 + Origin + owner |
| Skill 安装/任务、MCP 安装/测试 | 登录 + owner | 登录 + Origin + owner |
| FileReference | 登录 + owner | 由 owner Session/Tool 链路创建 |
| Context Experiment、Evaluation | 登录 + owner/Session owner | 登录 + Origin + owner |
| Artifact 内部详情 | 登录 + owner | 登录 + Origin + owner |
| Artifact 公开内容 | 无需登录；opaque ID + `active` | 不开放 |
| 登录、Session 检查、退出 | 公开认证端点 | 仅执行认证语义 |

`local_admin` 与 `password_user` 是运行模式/Principal 类型，不是业务角色。所有生产账号当前拥有相同业务能力，只能访问自己的资源。

## 5. Agent 权限模型

Agent 权限分为四步，不等同于普通页面权限：

1. **身份与归属**：ACP 握手必须登录；`principalId` 固定到该连接创建的 Agent App。
2. **能力可见性**：仅把当前 Agent 已绑定且 ready/enabled 的 Built-in Tool、Skill、MCP 放入本轮 Runtime。
3. **调用授权**：Tool 配置为 `allow | ask | deny`；危险 Tool 的强制权限不能被 Agent 配置降级。
4. **执行约束**：获准调用仍必须经过 ToolRuntime 和对应 File/Process/Network 沙箱。

因此 Agent 侧具有“基于属性和上下文判断”的特征，但目前仍是代码内规则，不是通用 ABAC。

## 6. 公开 Artifact 最小实现

### 6.1 页面与管理入口分离

```text
分享/模型输出链接
/artifacts/:id
  → PublicArtifactPage
  → 匿名公开 API

我的产物列表
/me/artifacts/:id
  → AuthGate
  → ArtifactDetailPage
  → owner API + 归档/恢复 + 内部元数据
```

### 6.2 公开 API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/control/v1/public/artifacts/:id/preview` | 脱敏预览合同 |
| GET | `/api/control/v1/public/artifacts/:id/raw` | 文件或入口内容 |
| GET | `/api/control/v1/public/artifacts/:id/bundle/*path` | HTML Bundle 子资源 |
| GET | `/api/control/v1/public/artifacts/:id/content` | 下载文件或 Bundle ZIP |
| GET | `/api/control/v1/public/artifacts/:id/pptx-playback` | 签发 PPTX 只读播放配置 |

没有公开列表、创建、覆盖、归档、恢复或内部详情接口。

### 6.3 服务端判定

```text
公开 GET
  → 路径和方法必须命中公开白名单
  → repository.get(artifactId)
  → 记录存在且 state == active
  → 返回脱敏 JSON 或校验后的 Blob 流

缺失 / 已归档
  → 统一 404
```

公开预览仅返回：`artifactId`、展示名、类型、版本、MIME、字节数和预览内容。不会返回 `ownerId`、来源 Session/Turn、SHA-256、operationId 或修订历史。

### 6.4 数据模型

- 不新增数据库字段，不做迁移。
- Artifact ID 继续使用 UUID 派生的 opaque ID。
- `active` 表示链接有效；owner 执行 archive 后，公开读取立即返回 404。
- 公开响应使用 `private, no-store`，减少归档后继续命中旧缓存的风险。

## 7. 安全边界

- “拿到链接即可访问”意味着链接本身就是 bearer capability；链接泄露即读取权限泄露。
- 生产环境必须继续使用 HTTPS，代理和日志也应把 Artifact ID 当作敏感标识。
- HTML Artifact 在 iframe 中仅允许脚本和下载，不包含 `allow-same-origin`；同时保留 CSP 与 `no-referrer`，防止他人产物继承应用同源权限。
- 二进制响应保留 `X-Content-Type-Options: nosniff`。
- Agent 的 `artifact://` Mention 仍调用 owner-scoped `resolveMentions`，公开链接不会扩大 Agent 对他人 Artifact 的上下文读取能力。
- 后续若要支持“私有/指定人/公开”三态，应新增显式 visibility/ACL；本次不引入该复杂度。

## 8. 验证与发布

已验证：

- 匿名 active 预览、原始内容、Bundle 子资源和下载成功；两层认证解析均未触发。
- 公共路径的 POST 仍返回 401。
- 内部 Artifact API 仍要求登录和 owner。
- 归档后公开请求返回 404，owner 仍可在管理页恢复。
- 公开 DTO 不包含内部字段。
- HTML iframe 不具备 `allow-same-origin`。
- Remote：76 个测试文件、395 个测试通过。
- Web：63 个测试文件、209 个测试通过。
- 全仓 typecheck、build、PPTX seccomp 校验通过。

发布后，原链接 `https://modelskindergarten.fun/artifacts/<artifactId>` 才会按新逻辑生效。

## 9. 主要代码位置

- 页面路由：`apps/web/src/main.tsx`
- 公开页面：`apps/web/src/product/PublicArtifactPage.tsx`
- 公开 API 客户端：`apps/web/src/api/control-api.ts`
- HTTP/Control Gate：`apps/remote/src/server/http-server.ts`、`control-api.ts`
- 公开路径判定：`apps/remote/src/server/public-artifact-request.ts`
- Artifact 路由与服务：`apps/remote/src/artifacts/artifact-routes.ts`、`artifact-service.ts`
- 公开响应合同：`packages/contracts/src/artifacts.ts`
- Agent owner 绑定：`apps/remote/src/index.ts`、`apps/remote/src/acp/kindergarten-agent.ts`
- Agent 能力与 Tool Gate：`apps/remote/src/capability/runtime-capability-resolver.ts`、`apps/remote/src/tools/permission-gate.ts`、`tool-runtime.ts`、`tool-registry.ts`
