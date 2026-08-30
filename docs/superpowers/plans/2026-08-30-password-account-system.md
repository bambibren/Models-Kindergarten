# 账号密码系统实施计划

> **执行要求：** 按任务顺序逐项实施；每一步使用复选框跟踪，先写测试，再写实现，并在每个阶段完成后提交代码。

**目标：** 为 MK 增加适合演示环境的账号密码系统，包括登录页面、未登录跳转、随机会话 Cookie、账号间数据隔离，以及只能通过服务器 SSH 使用的账号管理脚本。

**总体架构：** 本地源码开发和本机 Docker 预演继续使用 `AUTH_MODE=development`，保持现有 `local-admin` 行为。云端正式域名部署使用 `AUTH_MODE=required`：Remote 根据登录会话为每个 HTTP 请求和 ACP WebSocket 解析真实账号身份。浏览器只保存随机会话 Token，Remote 只保存 Token 的 SHA-256 哈希。

**技术栈：** TypeScript、Node.js 24 加密模块、React、Vitest、Docker Compose、Caddy。

---

## 账号系统技术架构图

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                                使用者                                                                │
│                                                                                                                      │
│                  浏览器登录用户                                                        SSH 运维人员                   │
│           用户名 + 密码 · HttpOnly Cookie                                      ubuntu + sudo · 不提供网页管理        │
└───────────────────────────────┬───────────────────────────────────────────────────────────────┬──────────────────────┘
                                │                                                               │
                                ▼                                                               ▼
┌───────────────────────────────────────────────────────────────────┐  ┌───────────────────────────────────────────────┐
│                        mk-web · Web 应用                           │  │            云服务器账号管理入口               │
│                                                                   │  │                                               │
│  ┌───────────────────────┐  ┌──────────────────────────────────┐  │  │  /usr/local/bin/mk-user                       │
│  │ /login                │  │ AuthGate                         │  │  │  ├─ add / list                               │
│  │                       │  │                                  │  │  │  ├─ reset-password                           │
│  │ 用户名                │  │ 检查 /auth/session               │  │  │  ├─ disable / enable                         │
│  │ 密码                  │  │ 未登录跳转 /login                │  │  │  └─ delete + 中文二次确认                    │
│  │ 登录错误              │  │ 登录后恢复原页面                 │  │  │                                               │
│  └───────────┬───────────┘  └────────────────┬─────────────────┘  │  │  只通过 SSH + sudo 操作                       │
│              │                               │                    │  │  不提供注册页和账号管理 API                   │
└──────────────┼───────────────────────────────┼────────────────────┘  └───────────────────────┬───────────────────────┘
               │                               │                                           │
               └───────────────────────┬───────┘                                           │
                                       ▼                                                   │
┌───────────────────────────────────────────────────────────────────────────────────────────┼──────────────────────────┐
│                                      mk-runtime · Remote                                  │                          │
│                                                                                           │                          │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐  │                          │
│  │ AuthService / PasswordAuthStore                                                     │  │                          │
│  │                                                                                     │  │                          │
│  │ POST /auth/login       scrypt 校验 ──▶ 随机 Token ──▶ Secure Cookie · 固定 30 天    │  │                          │
│  │ GET  /auth/session     Token 哈希查找 ──▶ AuthPrincipal                            │◀─┼──────────────────────────┘
│  │ POST /auth/logout      撤销当前登录会话                                              │  │
│  └───────────────────────────────────────┬─────────────────────────────────────────────┘  │
│                                          │                                                │
│                     ┌────────────────────┴────────────────────┐                           │
│                     ▼                                         ▼                           │
│  ┌───────────────────────────────────────┐  ┌──────────────────────────────────────────┐  │
│  │ Control API 认证边界                  │  │ ACP WebSocket 认证边界                   │  │
│  │                                       │  │                                          │  │
│  │ 未登录业务请求 ──▶ 401                │  │ Upgrade 前校验 Cookie                    │  │
│  │ 登录请求 ──▶ principalId              │  │ 未登录 ──▶ HTTP 401                      │  │
│  │ Route 只使用服务端 Principal          │  │ 每条连接固定绑定 principalId             │  │
│  └───────────────────┬───────────────────┘  └────────────────────┬─────────────────────┘  │
│                      │                                           │                        │
│                      └─────────────────────┬─────────────────────┘                        │
│                                            ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ 账号数据边界                                                                       │  │
│  │                                                                                     │  │
│  │ ModelStudent · Agent · Session / Turn · Skill · MCP · Experiment                   │  │
│  │ File / Workspace · Artifact / Blob · Encrypted Credential                          │  │
│  │                                  全部按 principalId 隔离                            │  │
│  └───────────────────────────────────────┬─────────────────────────────────────────────┘  │
└──────────────────────────────────────────┼────────────────────────────────────────────────┘
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                             持久数据层                                                               │
│                                                                                                                      │
│  /srv/mk/data/app/auth/users.json             用户名 · principalId · scrypt 盐与哈希 · 启用状态                    │
│  /srv/mk/data/app/auth/sessions.json          Token SHA-256 · principalId · 登录后固定 30 天过期                  │
│  /srv/mk/data/app/**                          各领域业务数据 · Workspace · Blob · 加密凭据                           │
│                                                                                                                      │
│  数据位于服务器持久目录，不进入 Git，不进入 Docker 镜像；容器重建后继续挂载使用                                      │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 登录与页面跳转流程图

```text
用户访问 /models/new、/、/session、/evaluation/*
                         │
                         ▼
              ┌──────────────────────┐
              │ AuthGate 检查会话    │
              │ GET /auth/session    │
              └──────────┬───────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
        已登录│                     │未登录 / Cookie 失效
              ▼                     ▼
┌──────────────────────────┐  ┌─────────────────────────────────────┐
│ 返回当前账号 Principal   │  │ 跳转 /login?next=<原页面路径>       │
│ 渲染原目标页面           │  └──────────────────┬──────────────────┘
└──────────────────────────┘                     ▼
                              ┌─────────────────────────────────────┐
                              │ 输入用户名和密码                    │
                              │ POST /auth/login                    │
                              └──────────────────┬──────────────────┘
                                                 │
                              ┌──────────────────┴──────────────────┐
                              │                                     │
                        验证失败│                                     │验证成功
                              ▼                                     ▼
                 ┌──────────────────────────┐       ┌──────────────────────────────────────┐
                 │ 显示“用户名或密码错误”  │       │ 生成随机 Token                       │
                 │ 不说明账号是否存在      │       │ 浏览器写入 HttpOnly + Secure Cookie  │
                 └──────────────────────────┘       └──────────────────┬───────────────────┘
                                                                       ▼
                                                    ┌──────────────────────────────────────┐
                                                    │ next 是安全站内路径 ──▶ 返回原页面    │
                                                    │ next 无效或缺失 ────▶ 返回首页 /      │
                                                    └──────────────────────────────────────┘
```

## HTTP 与 ACP 统一鉴权流程图

```text
浏览器同源请求
├─ HTTP  /api/control/v1/*
└─ WSS   /acp
        │
        ▼
┌─────────────────────────────────────────┐
│ 从 Cookie 读取 mk_session               │
│ 计算 SHA-256 后查询 auth/sessions.json  │
│ 校验登录后固定 30 天的 expiresAt        │
└────────────────────┬────────────────────┘
                     │
          ┌──────────┴──────────┐
          │                     │
  无 Token / 已过期       Token 有效
  账号禁用 / 已删除              │
          │                     ▼
          │          ┌──────────────────────────────┐
          │          │ 得到服务端 AuthPrincipal     │
          │          │ principalId 固定属于该账号   │
          │          └──────────────┬───────────────┘
          │                         │
          ▼              ┌─────────┴──────────┐
┌──────────────────┐     │                    │
│ HTTP ──▶ 401     │     ▼                    ▼
│ WSS  ──▶ 拒绝升级│  Control API          ACP Connection
└──────────────────┘  Route Context         Session Binding
                      │                    │
                      └──────────┬─────────┘
                                 ▼
                     所有读写按 principalId 过滤
                                 │
                  ┌──────────────┴──────────────┐
                  │                             │
              只看到本人数据              无法指定他人 ownerId
```

## SSH 账号管理与数据生命周期流程图

```text
ubuntu 通过 SSH 登录服务器
            │
            ▼
sudo /usr/local/bin/mk-user <command>
            │
            ├─ add
            │  └─ 两次无回显输入密码 ──▶ 创建账号与 scrypt 哈希
            │
            ├─ reset-password
            │  └─ 两次无回显输入新密码 ──▶ 更新哈希 ──▶ 撤销旧登录会话
            │
            ├─ disable
            │  └─ 禁止登录 ──▶ 撤销全部会话 ──▶ 完整保留业务数据
            │
            ├─ enable
            │  └─ 恢复登录 ──▶ 原业务数据继续可用
            │
            └─ delete --username <用户名>
               │
               ▼
       ┌────────────────────────────────────────────────────────┐
       │ 警告：永久删除账号及其全部业务数据，无法恢复           │
       │ 要求逐字输入：确认删除账号 <用户名>                    │
       └───────────────────────────┬────────────────────────────┘
                                   │
                        ┌──────────┴──────────┐
                        │                     │
                    输入不一致             输入完全一致
                        │                     │
                        ▼                     ▼
                 取消且不修改数据    撤销登录会话与活动任务
                                              │
                                              ▼
                                   按 principalId 删除业务数据
                                              │
                                              ▼
                              删除无共享引用的 Workspace / Blob / Secret
                                              │
                                              ▼
                                      最后删除账号记录
```

## 本地开发与云端部署关系图

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 本地源码开发 / 本机 Docker 预演                                                                                      │
│                                                                                                                      │
│ AUTH_MODE=development ──▶ local-admin ──▶ 不显示登录页                                                              │
│ 目标：保持现有开发效率，验证业务功能与 Docker 产物                                                                    │
└────────────────────────────────────────────────────────────┬─────────────────────────────────────────────────────────┘
                                                             │ 同一套源码与镜像
                                                             ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 云端正式域名                                                                                                         │
│                                                                                                                      │
│ https://modelskindergarten.fun ──▶ Caddy TLS ──▶ Web / Control API                                                  │
│ wss://modelskindergarten.fun/acp ───────────────▶ Remote ACP                                                        │
│                                                                                                                      │
│ AUTH_MODE=required ──▶ PasswordAuthStore ──▶ principalId 数据隔离                                                   │
│ SSH mk-user ──▶ /srv/mk/data/app/auth ──挂载──▶ mk-runtime:/data/auth                                               │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 一、账号与登录会话持久化

### 涉及文件

- 新增：`apps/remote/src/auth/password-auth-store.ts`
- 新增：`apps/remote/src/auth/auth-types.ts`
- 新增测试：`apps/remote/test/auth/password-auth-store.test.ts`
- 修改：`packages/contracts/src/control-api.ts`

### 实施步骤

- [ ] 编写密码验证、登录会话、禁用、改密和删除账号的失败测试。

```ts
const store = new PasswordAuthStore(join(dir, "users.json"), join(dir, "sessions.json"));
const user = await store.add("admin", "zhanglei234");
expect(await store.verify("admin", "zhanglei234")).toMatchObject({ principalId: user.principalId });
expect(await store.verify("admin", "wrong")).toBeUndefined();
const session = await store.createSession(user.principalId);
expect(await store.resolveSession(session.token)).toMatchObject({ principalId: user.principalId });
await store.disable("admin");
expect(await store.resolveSession(session.token)).toBeUndefined();
```

- [ ] 运行测试，确认因账号存储尚未实现而失败。

```bash
pnpm --filter @kindergarten/remote test -- --run test/auth/password-auth-store.test.ts
```

- [ ] 实现账号与登录会话合同。

```ts
export interface AuthPrincipal {
  schemaVersion: 1;
  principalId: string;
  kind: "password_user";
  username: string;
}

export interface PasswordAuthStore {
  add(username: string, password: string): Promise<AuthPrincipal>;
  list(): Promise<Array<AuthPrincipal & { disabled: boolean; createdAt: string }>>;
  verify(username: string, password: string): Promise<AuthPrincipal | undefined>;
  resetPassword(username: string, password: string): Promise<void>;
  disable(username: string): Promise<void>;
  enable(username: string): Promise<void>;
  remove(username: string): Promise<{ principalId: string }>;
  createSession(principalId: string): Promise<{ token: string; expiresAt: string }>;
  resolveSession(token: string): Promise<AuthPrincipal | undefined>;
  revokeSession(token: string): Promise<void>;
}
```

- [ ] 使用随机 16 字节盐和 Node.js `scrypt` 生成密码哈希，使用 `timingSafeEqual` 比较结果。
- [ ] 每次登录生成 32 字节随机 Token，只在服务端保存 `sha256(token)`；`expiresAt` 固定为登录成功时间之后 30 天。
- [ ] 普通页面访问和 API 调用不自动延长过期时间；重新登录会生成新 Token，并重新获得 30 天有效期。
- [ ] 账号文件和会话文件采用“同目录临时文件 + 原子重命名”写入。
- [ ] 用户名忽略大小写，去除首尾空格，长度限制为 3–32，仅允许英文字母、数字、下划线和连字符。
- [ ] 运行测试并提交。

```bash
pnpm --filter @kindergarten/remote test -- --run test/auth/password-auth-store.test.ts
git add packages/contracts/src/control-api.ts apps/remote/src/auth apps/remote/test/auth/password-auth-store.test.ts
git commit -m "feat(auth): add password account store"
```

---

## 二、保护 Control API 与 ACP WebSocket

### 涉及文件

- 新增：`apps/remote/src/auth/auth-service.ts`
- 新增：`apps/remote/src/auth/auth-routes.ts`
- 修改：`apps/remote/src/server/control-api.ts`
- 修改：`apps/remote/src/server/control-router.ts`
- 修改：`apps/remote/src/server/http-server.ts`
- 修改：`apps/remote/src/acp/kindergarten-agent.ts`
- 修改：`apps/remote/src/session/session-binding-service.ts`
- 修改：`apps/remote/src/config/deployment-config.ts`
- 修改：`apps/remote/src/index.ts`
- 新增测试：`apps/remote/test/auth/auth-routes.test.ts`
- 修改测试：`apps/remote/test/websocket.test.ts`
- 修改测试：`apps/remote/test/config/deployment-config.test.ts`

### 实施步骤

- [ ] 编写以下失败测试：未登录访问业务 API 返回 401；正确密码设置安全 Cookie；错误密码使用统一提示；未登录 ACP 升级返回 401；登录后的 ACP 可以连接。

```ts
expect((await request("GET", "/api/control/v1/models")).status).toBe(401);
const login = await request("POST", "/api/control/v1/auth/login", {
  username: "admin",
  password: "zhanglei234",
});
expect(login.headers.get("set-cookie")).toContain("HttpOnly");
expect(login.headers.get("set-cookie")).toContain("Secure");
expect(login.headers.get("set-cookie")).toContain("SameSite=Lax");
```

- [ ] 实现三个公开认证接口。

```text
POST /api/control/v1/auth/login    用户名和密码 → 设置 Cookie
GET  /api/control/v1/auth/session  Cookie → 当前账号或 401
POST /api/control/v1/auth/logout   Cookie → 撤销会话并清除 Cookie
```

- [ ] Cookie 名称固定为 `mk_session`，属性固定为 `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`，其中 `2592000` 秒等于 30 天。
- [ ] 登录失败统一返回“用户名或密码错误”，不暴露账号是否存在。
- [ ] `/health/live` 和 `/health/ready` 保持公开；其他 Control API 在正式模式下必须先解析登录 Cookie。
- [ ] ACP 在 WebSocket 升级前验证 Cookie，失败时直接返回 HTTP 401，不创建 ACP 对象。
- [ ] 每条 ACP 连接绑定服务端解析出的 `principalId`；创建、列出、加载、恢复、对话、关闭和修改 Session 配置都按该 ID 隔离。
- [ ] 保留开发模式 `local-admin`；正式模式必须使用 HTTPS，并且至少存在一个未禁用账号才能启动。
- [ ] 运行测试并提交。

```bash
pnpm --filter @kindergarten/remote test -- --run test/auth/auth-routes.test.ts test/websocket.test.ts test/config/deployment-config.test.ts
git add apps/remote/src apps/remote/test packages/contracts/src/control-api.ts
git commit -m "feat(auth): protect HTTP and ACP with login sessions"
```

---

## 三、账号数据隔离与账号删除

### 涉及文件

- 新增：`apps/remote/src/auth/account-data-service.ts`
- 修改模型、Agent、Session、Skill、MCP、Experiment、Artifact、文件和 Secret 相关 Repository
- 新增测试：`apps/remote/test/auth/account-data-service.test.ts`

### 实施步骤

- [ ] 创建两个账号的完整业务数据，编写删除账号 A 后账号 B 数据保持不变的失败测试。

```ts
await fixtures.createAllOwnedData("user_a");
await fixtures.createAllOwnedData("user_b");
await service.deleteAll("user_a");
expect(await fixtures.countOwnedData("user_a")).toBe(0);
expect(await fixtures.countOwnedData("user_b")).toBeGreaterThan(0);
```

- [ ] 为各 Repository 增加按 `ownerId` 删除的方法。
- [ ] 删除顺序固定为：活动会话和任务、模型与凭据、Agent、Session、Skill、MCP、Experiment、文件、Artifact、Workspace，最后删除账号记录。
- [ ] Artifact Blob、文件 Blob 和加密凭据只有在没有其他账号引用时才删除。
- [ ] 任一业务数据删除阶段失败时保留账号记录并返回失败，不制造“账号已删但数据残留”的假成功。
- [ ] 禁用账号只撤销登录会话，绝不调用业务数据删除服务。
- [ ] 运行测试并提交。

```bash
pnpm --filter @kindergarten/remote test -- --run test/auth/account-data-service.test.ts
git add apps/remote/src apps/remote/test/auth/account-data-service.test.ts
git commit -m "feat(auth): isolate and delete account business data"
```

---

## 四、登录页面与未登录跳转

### 涉及文件

- 新增：`apps/web/src/product/LoginPage.tsx`
- 新增：`apps/web/src/product/AuthGate.tsx`
- 新增：`apps/web/src/product/auth-client.ts`
- 新增测试：`apps/web/src/product/LoginPage.test.tsx`
- 新增测试：`apps/web/src/product/AuthGate.test.tsx`
- 修改：`apps/web/src/main.tsx`
- 修改：`apps/web/src/product/product.css`

### 实施步骤

- [ ] 编写未登录跳转和登录表单失败测试。
- [ ] `/login` 页面只包含用户名、密码、登录按钮和错误提示，不提供注册入口。
- [ ] 所有产品页面及 `/evaluation/*` 使用 `AuthGate`；认证接口返回 401 时跳转到 `/login?next=<原页面路径>`。
- [ ] `next` 只接受以单个 `/` 开头的站内路径，拒绝 `//` 开头和外部 URL。
- [ ] 登录成功后返回原页面；没有合法 `next` 时进入 `/`。
- [ ] 登录失败停留在登录页并显示“用户名或密码错误”。
- [ ] 静态 JS、CSS 和 `/skills/*` 保持可读取，以保证登录页加载和 Runtime 内网下载 Skills。
- [ ] 运行测试、构建 Web 并提交。

```bash
pnpm --filter @kindergarten/web test -- --run src/product/LoginPage.test.tsx src/product/AuthGate.test.tsx
pnpm --filter @kindergarten/web build
git add apps/web/src
git commit -m "feat(web): add password login and route guard"
```

---

## 五、服务器 SSH 账号管理脚本

### 涉及文件

- 新增：`apps/remote/src/auth/auth-user-cli.ts`
- 新增：`deploy/scripts/mk-user.sh`
- 新增测试：`apps/remote/test/auth/auth-user-cli.test.ts`
- 修改：`apps/remote/package.json`
- 修改：`deploy/images/Dockerfile.runtime`
- 修改：`deploy/scripts/cloud-deploy.mjs`
- 修改：`deploy/README.md`

### 支持命令

```bash
sudo /usr/local/bin/mk-user add --username <用户名>
sudo /usr/local/bin/mk-user list
sudo /usr/local/bin/mk-user reset-password --username <用户名>
sudo /usr/local/bin/mk-user disable --username <用户名>
sudo /usr/local/bin/mk-user enable --username <用户名>
sudo /usr/local/bin/mk-user delete --username <用户名>
```

### 实施规则

- [ ] 新增账号和修改密码必须在终端中输入两次密码，输入过程不回显。
- [ ] 密码不能作为命令行参数，避免进入 shell 历史和进程列表。
- [ ] 禁用账号立即撤销该账号全部登录会话，并提示“业务数据已保留”。
- [ ] 删除账号时输出：

```text
警告：这会永久删除账号“<用户名>”及其全部业务数据，无法恢复。
请输入：确认删除账号 <用户名>
```

- [ ] 只有逐字输入确认内容才执行；其他输入全部取消。
- [ ] 账号管理不提供任何 HTTP 接口，只能通过服务器 SSH 和 `sudo` 使用。
- [ ] 运行测试并提交。

```bash
pnpm --filter @kindergarten/remote test -- --run test/auth/auth-user-cli.test.ts
git add apps/remote/src/auth apps/remote/test/auth apps/remote/package.json deploy
git commit -m "feat(auth): add SSH account administration"
```

---

## 六、完整验证与正式部署

- [ ] 运行仓库完整检查。

```bash
pnpm check
```

- [ ] 验证本机 Docker 预演继续使用开发身份，不出现登录页。

```bash
pnpm deploy:preview
pnpm deploy:preview:smoke
```

- [ ] 构建并推送 `linux/amd64` 的不可变 `mk-runtime` 和 `mk-web` 镜像，记录镜像摘要和 Git Commit 到发布清单。
- [ ] 在服务器上通过交互式命令创建默认账号：

```bash
ssh zhanglei234
sudo /usr/local/bin/mk-user add --username admin
```

两次输入密码 `zhanglei234`。服务器只保存 `scrypt` 哈希；Git、镜像、Compose、发布清单和 shell 历史都不保存明文密码。

- [ ] 执行正式域名部署。

```bash
pnpm deploy:cloud:domain -- \
  --server zhanglei234 \
  --domain modelskindergarten.fun \
  --office-domain office.modelskindergarten.fun \
  --manifest deploy/releases/2026-08-30-auth/release-manifest.json \
  --confirm-production-ready
```

- [ ] 验证以下结果：

```text
HTTP 自动跳转 HTTPS
未登录访问 /models/new 自动跳转 /login
admin / zhanglei234 可以登录
登录 Token 和 Cookie 在登录成功 30 天后失效，普通访问不自动续期
登录后 Control API 和 wss://modelskindergarten.fun/acp 正常
不同账号无法读取对方数据
https://office.modelskindergarten.fun 正常
```

- [ ] 正式验证完成后删除腾讯云 TCP 8080 临时规则，保留 TCP 234、80 和 443。

---

## 自检结论

- 默认账号、密码登录、无注册、未登录跳转、HTTP/ACP 认证、账号数据隔离、改密、禁用、启用及二次确认删除均有对应任务和测试。
- 初始密码只通过服务器交互式命令输入，不进入源码、镜像或发布配置。
- Control API、ACP、Repository 与删除服务统一使用服务端解析出的 `principalId`，不信任浏览器或 ACP 请求提供的账号归属。
