# Models Kindergarten Three-Stage Docker Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立本机 Docker、公网 IP、正式域名三个连续部署阶段，并先把运行真实构建产物的本机 Docker 阶段自动化验收通过。

**Architecture:** 两个 MK 自有镜像分别承载 Caddy/Web/Skill 静态资源和 Remote/Evaluation，ONLYOFFICE 使用官方镜像。三个阶段复用 Dockerfile、Compose 服务拓扑和同源路由，只替换入口地址、镜像来源、Secret 与持久目录；Web 根据页面协议自动选择 WS 或 WSS。

**Tech Stack:** pnpm workspace、Node.js 24、Vite、Caddy、Docker Compose、ONLYOFFICE、GitHub Container Registry、SSH/SCP。

---

### Task 1: 固化部署目录和静态 Skill 构建输入

**Files:**
- Create: `.dockerignore`
- Create: `resource/export-static.mjs`
- Modify: `resource/server.mjs`
- Modify: `resource/test/server.test.mjs`

- [ ] **Step 1: 为静态 Skill 导出写失败测试**

验证导出目录包含 `skills/index.json`、每个 Skill 的 JSON bundle，并保持现有内容哈希和 Content-Type 合同。

- [ ] **Step 2: 运行 Resource 测试并确认新测试失败**

Run: `pnpm --filter @kindergarten/resource test`

Expected: FAIL，因为静态导出函数尚不存在。

- [ ] **Step 3: 实现静态 Skill 导出命令**

复用 `buildSkillBundle()`，不在 Dockerfile 中重新实现协议；输出只包含允许进入 `mk-web` 镜像的 `resource/skills`。

- [ ] **Step 4: 运行 Resource 测试**

Run: `pnpm --filter @kindergarten/resource test`

Expected: PASS。

### Task 2: 构建两个自有镜像和三容器拓扑

**Files:**
- Create: `deploy/images/Dockerfile.web`
- Create: `deploy/images/Dockerfile.runtime`
- Create: `deploy/Caddyfile`
- Create: `deploy/compose.yaml`
- Create: `deploy/env/preview.env.example`
- Create: `deploy/local/.gitkeep`
- Modify: `.gitignore`

- [ ] **Step 1: 创建 mk-web 多阶段镜像**

在 Node 构建阶段生成 Web dist 和静态 Skill bundle，最终 Caddy 层只携带构建结果，不挂载源码。

- [ ] **Step 2: 创建 mk-runtime 多阶段镜像**

构建 Remote ESM bundle，复制生产依赖与 Builtin Skills；主进程固定 UID 10001，数据只写 `/data`。

- [ ] **Step 3: 创建同源 Caddy 路由**

固定 `/api/*`、`/acp`、`/skills/*` 和 Web SPA 回退；本机 ONLYOFFICE 使用 `office.mk.localhost` 进入同一 Gateway。

- [ ] **Step 4: 创建 Compose 拓扑**

服务固定为 `mk-web`、`mk-app`、`mk-onlyoffice`；只有 `mk-web` 发布端口，Remote 与 ONLYOFFICE 只使用 Docker 内网。

- [ ] **Step 5: 校验 Compose 配置**

Run: `docker compose --env-file deploy/env/preview.env.example -f deploy/compose.yaml config`

Expected: 配置解析成功，且 `mk-app`、`mk-onlyoffice` 没有宿主端口映射。

### Task 3: 一键本机 Docker 命令和自动冒烟测试

**Files:**
- Create: `deploy/scripts/secret-init.mjs`
- Create: `deploy/scripts/preview-build.sh`
- Create: `deploy/scripts/preview-up.sh`
- Create: `deploy/scripts/preview-down.sh`
- Create: `deploy/scripts/preview-smoke.mjs`
- Modify: `package.json`

- [ ] **Step 1: 实现幂等主密钥初始化**

首次创建 `deploy/local/secrets/mk_master_key` 并设置 `0600`；已有文件只校验，不覆盖。

- [ ] **Step 2: 实现构建、启动和停止命令**

根命令提供 `deploy:build`、`deploy:preview:up`、`deploy:preview:smoke`、`deploy:preview:down` 和一键 `deploy:preview`。

- [ ] **Step 3: 实现冒烟测试**

自动断言 Web、live/ready、Control API、Evaluation、两个 Skill bundle、ACP initialize、ONLYOFFICE 健康、非 root UID、Secret 权限和 `/data` 重启持久化。

- [ ] **Step 4: 执行本机 Docker 完整验收**

Run: `pnpm deploy:preview`

Expected: 两个镜像构建成功，三个容器健康，全部冒烟断言通过。

### Task 4: 公网 IP 与正式域名部署命令边界

**Files:**
- Create: `deploy/scripts/cloud-deploy.mjs`
- Create: `deploy/env/cloud-ip.env.example`
- Create: `deploy/env/cloud-domain.env.example`
- Modify: `package.json`

- [ ] **Step 1: 实现两种云端入口参数校验**

`cloud-ip` 只接受 HTTP 公网 IP，`cloud-domain` 只接受 HTTPS 域名；二者都要求云服务器 SSH 地址和已生成的 release manifest。

- [ ] **Step 2: 实现配置上传和远程执行**

通过 SCP 上传 Compose、环境文件和发布清单，通过 SSH 执行目录检查、镜像拉取、启动、健康检查；镜像本身只从 GHCR 拉取。

- [ ] **Step 3: 加入 dry-run 测试路径**

Run: `pnpm deploy:cloud:ip -- --server deploy@example --ip 203.0.113.10 --manifest deploy/examples/release-manifest.example.json --dry-run`

Expected: 输出完整 SCP/SSH 操作但不访问服务器。

### Task 5: 同步三阶段技术文档

**Files:**
- Modify: `outputs/models-kindergarten-phase2-docker-cloud-deployment.md`
- Modify: `outputs/models-kindergarten-deployment-architecture.md`
- Modify: `outputs/models-kindergarten-development-build-release-architecture.md`
- Modify: `outputs/models-kindergarten-architecture-diagrams.md`

- [ ] **Step 1: 把部署验收改成三个阶段**

明确本机 `http/ws`、公网 IP `http/ws`、域名 `https/wss`，删除公网 IP 内部证书中间阶段。

- [ ] **Step 2: 补齐镜像、配置、数据和 Secret 的四条交付路径**

展示 GHCR pull、SSH/SCP、宿主机持久目录和服务器端 Secret 初始化。

- [ ] **Step 3: 标明云端命令购买前后的可执行边界**

本机 Docker 立即可执行；公网 IP 命令依赖云服务器；域名命令依赖服务器、域名、DNS 与 80/443 可达。

### Task 6: 全量回归与状态核对

**Files:**
- Modify only if tests expose a scoped defect.

- [ ] **Step 1: 执行代码回归**

Run: `pnpm check`

Expected: typecheck、test、build 全部通过。

- [ ] **Step 2: 核对镜像内容和运行身份**

Run: `docker compose --env-file deploy/env/preview.env.example -f deploy/compose.yaml images`

Expected: `mk-web`、`mk-runtime`、ONLYOFFICE 三个镜像，对应 `mk-web`、`mk-app`、`mk-onlyoffice` 三个容器。

- [ ] **Step 3: 核对工作区变更**

Run: `git status --short`

Expected: 只有本次部署实现和计划文档，没有 `.data`、主密钥、日志或构建产物进入 Git。
