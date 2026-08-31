# Docker 内部服务地址统一配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 MK 的公网地址与 Docker 容器内部地址彻底分离，以集中、必填、可校验的内部拓扑配置修复生产环境 Skill 下载被 HTTPS 重定向的问题，并覆盖所有当前跨容器 HTTP 调用。

**Architecture:** `deploy/env/internal.env` 是 Docker 内部拓扑的唯一配置源，声明 Web 内部监听地址以及 Web、Runtime、ONLYOFFICE 三个内部 origin。Compose 只消费必填变量；Caddy 使用独立纯 HTTP 内部站点提供 Skills，不向宿主机发布该端口；本机和云端冒烟测试都从 `mk-app` 容器验证三个内部 origin，禁止重定向。

**Tech Stack:** Docker Compose、Caddy 2、Node.js 24、Shell、TypeScript/JavaScript、Node test、文本架构文档。

---

## 文件结构

- Create: `deploy/env/internal.env` — Docker 内部服务拓扑的单一配置源。
- Create: `deploy/scripts/internal-origin-probe.mjs` — 在 `mk-app` 中执行的只读内部连通性探针。
- Modify: `deploy/compose.yaml` — 强制注入内部地址，不再写死服务名和端口。
- Modify: `deploy/Caddyfile` — 复用 Skills 路由并增加独立纯 HTTP 内网站点。
- Modify: `deploy/images/Dockerfile.web` — 声明内部监听端口。
- Modify: `deploy/scripts/preview-build.sh`、`preview-up.sh`、`preview-down.sh`、`preview-smoke.mjs` — 统一加载内部拓扑并执行内部探针。
- Modify: `deploy/scripts/cloud-deploy.mjs`、`mk-user.sh` — 上传、加载、校验内部拓扑并在发布切换前执行探针。
- Modify: `deploy/env/*.env.example`、`deploy/README.md` — 说明公网配置与内部配置的职责边界。
- Modify: `docs/ARCHITECTURE.md`、`docs/MCP_SKILLS.md` — 同步最终技术架构。
- Modify: `outputs/*.md` 中的现行架构与部署文档 — 同步文本架构图，不加入变更历史。

### Task 1: 建立内部拓扑配置与 Compose 强制校验

**Files:**
- Create: `deploy/env/internal.env`
- Modify: `deploy/compose.yaml`
- Modify: `deploy/images/Dockerfile.web`

- [ ] **Step 1: 创建单一内部拓扑配置**

```dotenv
MK_WEB_INTERNAL_SITE_ADDRESS=http://:8082
MK_WEB_INTERNAL_ORIGIN=http://mk-web:8082
MK_RUNTIME_INTERNAL_ORIGIN=http://mk-app:7331
MK_ONLYOFFICE_INTERNAL_ORIGIN=http://mk-onlyoffice:80
```

- [ ] **Step 2: 将 Compose 中的跨容器地址改成必填变量**

```yaml
mk-web:
  environment:
    MK_WEB_INTERNAL_SITE_ADDRESS: ${MK_WEB_INTERNAL_SITE_ADDRESS:?必须配置 MK_WEB_INTERNAL_SITE_ADDRESS}
    MK_RUNTIME_INTERNAL_ORIGIN: ${MK_RUNTIME_INTERNAL_ORIGIN:?必须配置 MK_RUNTIME_INTERNAL_ORIGIN}
    MK_ONLYOFFICE_INTERNAL_ORIGIN: ${MK_ONLYOFFICE_INTERNAL_ORIGIN:?必须配置 MK_ONLYOFFICE_INTERNAL_ORIGIN}

mk-app:
  environment:
    MK_WEB_INTERNAL_ORIGIN: ${MK_WEB_INTERNAL_ORIGIN:?必须配置 MK_WEB_INTERNAL_ORIGIN}
    MK_RUNTIME_INTERNAL_ORIGIN: ${MK_RUNTIME_INTERNAL_ORIGIN:?必须配置 MK_RUNTIME_INTERNAL_ORIGIN}
    MK_ONLYOFFICE_INTERNAL_ORIGIN: ${MK_ONLYOFFICE_INTERNAL_ORIGIN:?必须配置 MK_ONLYOFFICE_INTERNAL_ORIGIN}
    SKILL_RESOURCE_FETCH_BASE: ${MK_WEB_INTERNAL_ORIGIN:?必须配置 MK_WEB_INTERNAL_ORIGIN}
    ONLYOFFICE_ARTIFACT_BASE_URL: ${MK_RUNTIME_INTERNAL_ORIGIN:?必须配置 MK_RUNTIME_INTERNAL_ORIGIN}/api/control/v1
```

- [ ] **Step 3: 验证缺少内部配置时 Compose 失败**

Run:

```bash
env -i PATH="$PATH" docker compose -f deploy/compose.yaml config
```

Expected: FAIL，并指出缺少 `MK_WEB_INTERNAL_SITE_ADDRESS` 或内部 origin。

- [ ] **Step 4: 验证加载内部配置后 Compose 成功**

Run:

```bash
docker compose --env-file deploy/env/internal.env --env-file deploy/env/preview.env.example -f deploy/compose.yaml config --quiet
```

Expected: PASS。

### Task 2: 增加不重定向的 Caddy 内部 Skills 站点

**Files:**
- Modify: `deploy/Caddyfile`
- Modify: `deploy/images/Dockerfile.web`

- [ ] **Step 1: 提取可复用的 Skills 路由片段**

```caddyfile
(skill_resources) {
    @skillList path /skills
    handle @skillList {
        rewrite * /skills/index.json
        header Content-Type "application/json; charset=utf-8"
        root * /srv
        file_server
    }

    @skillBundle path_regexp skill ^/skills/[a-z0-9-]+$
    handle @skillBundle {
        rewrite * {path}.json
        header Content-Type "application/vnd.mk.skill+json; charset=utf-8"
        header Cache-Control "no-cache"
        root * /srv
        file_server
    }
}
```

- [ ] **Step 2: 公网站点和内部站点共同导入路由**

```caddyfile
{$MK_SITE_ADDRESS} {
    import skill_resources
}

{$MK_WEB_INTERNAL_SITE_ADDRESS} {
    import skill_resources
    respond 404
}
```

内部站点使用明确的 `http://` 地址，不触发 Caddy 自动 HTTPS；该端口不加入 Compose `ports`。

- [ ] **Step 3: 声明镜像内部端口**

```dockerfile
EXPOSE 8080 8081 8082 8443
```

### Task 3: 为本机与云端共用内部连通性探针

**Files:**
- Create: `deploy/scripts/internal-origin-probe.mjs`
- Modify: `deploy/scripts/preview-smoke.mjs`
- Modify: `deploy/scripts/cloud-deploy.mjs`

- [ ] **Step 1: 编写只读探针**

```js
const webOrigin = required("MK_WEB_INTERNAL_ORIGIN");
const list = await request("Web Skill list", `${webOrigin}/skills`, "application/json").then((response) => response.json());
const skillName = list.skills.find((item) => typeof item.name === "string").name;
const bundle = await request("Web Skill bundle", `${webOrigin}/skills/${encodeURIComponent(skillName)}`, "application/vnd.mk.skill+json").then((response) => response.json());
if (bundle.kind !== "mk-skill-bundle" || bundle.name !== skillName) throw new Error("Web Skill bundle 结构无效");
await request("Runtime", `${required("MK_RUNTIME_INTERNAL_ORIGIN")}/health/ready`, "application/json");
await request("ONLYOFFICE", `${required("MK_ONLYOFFICE_INTERNAL_ORIGIN")}/healthcheck`);
```

- [ ] **Step 2: 本机 Smoke 从 mk-app 执行探针**

```js
compose("exec", "-T", "mk-app", "node", "/app/deploy/scripts/internal-origin-probe.mjs");
```

如果最终 Runtime 镜像不携带 `deploy/scripts`，则通过 `node -e` 运行同一探针模块导出的源码字符串，避免在镜像中复制部署目录。

- [ ] **Step 3: 云端容器启动后、切换 current 软链接前执行同一探针**

```text
docker compose ... up --wait
docker compose ... exec -T mk-app node -e '<probe>'
curl 公网 /health/ready
ln -sfn 新 release /srv/mk/current
```

Expected: 内部任一请求发生 301/308、连接失败、状态码错误或 Content-Type 错误时发布失败。

### Task 4: 所有 Compose 命令加载相同内部拓扑

**Files:**
- Modify: `deploy/scripts/preview-build.sh`
- Modify: `deploy/scripts/preview-up.sh`
- Modify: `deploy/scripts/preview-down.sh`
- Modify: `deploy/scripts/preview-smoke.mjs`
- Modify: `deploy/scripts/cloud-deploy.mjs`
- Modify: `deploy/scripts/mk-user.sh`

- [ ] **Step 1: 本机命令同时加载两个 env 文件**

```bash
docker compose \
  --env-file deploy/env/internal.env \
  --env-file deploy/env/preview.env.example \
  -f deploy/compose.yaml ...
```

- [ ] **Step 2: 云端上传 internal.env**

```js
run("scp", [
  resolve(repoRoot, "deploy/compose.yaml"),
  resolve(repoRoot, "deploy/env/internal.env"),
  // 其余文件
  `${server}:${remoteRelease}/`,
]);
```

- [ ] **Step 3: 云端与 mk-user 同时加载 internal.env 和 release.env**

```bash
docker compose --env-file internal.env --env-file release.env -f compose.yaml ...
```

- [ ] **Step 4: 检查脚本中不存在只加载 release/preview env 的活动 Compose 命令**

Run:

```bash
rg -n -- '--env-file' deploy/scripts
```

Expected: 所有活动 Compose 调用都先加载 `internal.env`。

### Task 5: 同步最终架构文档

**Files:**
- Modify: `deploy/README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/MCP_SKILLS.md`
- Modify: `deploy/env/cloud-domain.env.example`
- Modify: `deploy/env/cloud-ip.env.example`
- Modify: `deploy/env/preview.env.example`
- Modify: `outputs/models-kindergarten-architecture-diagrams.md`
- Modify: `outputs/models-kindergarten-deployment-architecture.md`
- Modify: `outputs/models-kindergarten-phase1-local-refactor.md`
- Modify: `outputs/models-kindergarten-phase2-docker-cloud-deployment.md`
- Modify: `outputs/models-kindergarten-development-build-release-architecture.md`
- Modify: `outputs/models-kindergarten-tencent-cloud-purchase-guide.md`

- [ ] **Step 1: 文档统一使用最终文本架构**

```text
公网入口
└─ mk-web 公网站点
   ├─ Web / API / ACP / Skills
   └─ ONLYOFFICE 域名

Docker 内部地址
├─ MK_WEB_INTERNAL_ORIGIN       → mk-web 内部 Skills 站点
├─ MK_RUNTIME_INTERNAL_ORIGIN   → mk-app
└─ MK_ONLYOFFICE_INTERNAL_ORIGIN→ mk-onlyoffice
```

- [ ] **Step 2: 写清内部端口不发布到宿主机**

文档只描述最终方案：内部服务监听 Docker 网络地址；只有 Caddy 的公网入口发布到宿主机；内部拓扑来自 `deploy/env/internal.env`，缺少配置时 Compose 直接失败。

- [ ] **Step 3: 清理过时的固定内部地址描述**

Run:

```bash
rg -n 'SKILL_RESOURCE_FETCH_BASE=http://mk-web:8080|Docker / 云端：http://mk-web:8080' \
  docs deploy \
  /Users/bones/Documents/Codex/2026-08-27/users-bones-develop-joycode-docs-acp/outputs
```

Expected: 无结果。

### Task 6: 完整验证、固化与发布

**Files:**
- Create: `deploy/releases/<release>/release-manifest.json`

- [ ] **Step 1: 静态校验**

Run:

```bash
git diff --check
pnpm typecheck
pnpm test
pnpm build
```

Expected: 全部通过。

- [ ] **Step 2: 本机 Docker 预演**

Run:

```bash
pnpm deploy:preview
```

Expected: 公网入口、三个内部 origin、ACP、Evaluation、ONLYOFFICE、Secret 权限和持久化全部通过。

- [ ] **Step 3: 提交实现**

```bash
git add deploy docs apps packages
git commit -m "fix: separate public and internal service origins"
```

- [ ] **Step 4: 构建并推送 linux/amd64 不可变镜像**

```bash
docker buildx build --platform linux/amd64 -f deploy/images/Dockerfile.web -t ghcr.io/bambibren/models-kindergarten/mk-web:<release> --push .
docker buildx build --platform linux/amd64 -f deploy/images/Dockerfile.runtime -t ghcr.io/bambibren/models-kindergarten/mk-runtime:<release> --push .
```

- [ ] **Step 5: 部署正式域名并验收失败会话对应能力**

```bash
pnpm deploy:cloud:domain -- \
  --server zhanglei234 \
  --domain modelskindergarten.fun \
  --office-domain office.modelskindergarten.fun \
  --manifest deploy/releases/<release>/release-manifest.json \
  --confirm-production-ready
```

Expected: `mk-app` 内部下载 `website-design-fast` 返回 200 且无重定向；线上三个容器 healthy；公网 Skills、API、ACP 和 ONLYOFFICE 正常。

---

## 自检

- 需求覆盖：内部端口通用配置、禁止写死、生产与预演统一、文档同步、自动部署均有对应任务。
- 安全边界：内部监听不发布公网；公开 URL 继续用于授权和安装记录；下载器继续拒绝重定向。
- 类型一致：站点监听使用 `MK_WEB_INTERNAL_SITE_ADDRESS`，跨容器调用统一使用三个 `*_INTERNAL_ORIGIN`。
- 无占位实现：每个任务都包含目标文件、配置字段、执行命令和验收结果。
