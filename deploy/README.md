# MK 三阶段 Docker 部署

```text
阶段一  本机 Docker    http://127.0.0.1:7410 + ws://127.0.0.1:7410/acp
阶段二  公网 IP        http://公网IP + ws://公网IP/acp
阶段三  正式域名       https://域名 + wss://域名/acp
```

## 阶段一：本机 Docker

```bash
pnpm deploy:preview
```

该命令创建独立主密钥，构建 `mk-web` 和 `mk-runtime`，启动 `mk-web`、`mk-app`、`mk-onlyoffice`，并自动验证 Web、API、Evaluation、Skills、ACP、ONLYOFFICE、非 root、Secret 权限、PPTX Linux Runtime 和数据重启持久化。PPTX 验收只在容器内生成并结构检查临时单页文件，完成后删除，不发布 Artifact。

```bash
pnpm deploy:preview:smoke
pnpm deploy:preview:down
```

预演数据位于 `deploy/local/data`，主密钥位于 `deploy/local/secrets`，二者均不进入 Git 或镜像。

## 公网地址与 Docker 内部地址

```text
公网入口
└─ mk-web
   ├─ Web / API / ACP / Skills
   └─ ONLYOFFICE 独立域名或预演入口

Docker 内部调用
├─ MK_WEB_INTERNAL_ORIGIN        → mk-web 纯 HTTP Skills 站点
├─ MK_RUNTIME_INTERNAL_ORIGIN    → mk-app
└─ MK_ONLYOFFICE_INTERNAL_ORIGIN → mk-onlyoffice
```

内部拓扑统一保存在 `deploy/env/internal.env`。Compose 把这些字段作为必填配置；缺少任一字段时，构建、预演和云端部署都会在启动容器前失败。业务代码只读取语义配置，不写死 Docker 服务名或端口。

`MK_WEB_INTERNAL_SITE_ADDRESS` 是 Caddy 的纯 HTTP 内部监听地址。该端口只在 Docker 网络中使用，不配置宿主机 `ports`，不会暴露到本机局域网或云服务器公网。公开 Skill URL 继续用于来源授权和安装记录；Remote 下载时使用 `MK_WEB_INTERNAL_ORIGIN`，并继续拒绝重定向。

## 阶段二：公网 IP

前置条件：已经购买 Linux 云服务器，安装 Docker Compose，创建 SSH deploy 用户，把服务器限制为本人来源访问，并使用只读 Token 登录私有 GHCR。

```bash
pnpm deploy:cloud:ip -- \
  --server deploy@公网IP \
  --ip 公网IP \
  --manifest deploy/releases/版本/release-manifest.json \
  --allow-http-preview
```

该阶段临时使用 HTTP/WS；真实 API Key 和正式用户登录等到域名 HTTPS 阶段再验收。

## 阶段三：正式域名

前置条件：主域名和 ONLYOFFICE 子域名已经解析到服务器，80/443 可达，`AUTH_MODE=required`、登录身份、Secure Cookie 和 ONLYOFFICE JWT 已实施并验收。

```bash
pnpm deploy:cloud:domain -- \
  --server deploy@公网IP \
  --domain mk.example.com \
  --office-domain office.mk.example.com \
  --manifest deploy/releases/版本/release-manifest.json \
  --confirm-production-ready
```

云端命令只通过 SCP 上传 Compose、PPTX Runtime seccomp profile、环境文件和 release manifest；镜像由云服务器从私有 GHCR 按摘要拉取，业务数据和主密钥保存在 `/srv/mk/data` 与 `/srv/mk/secrets`。

## Web 镜像发布唯一入口

Web 镜像同时承载前端和 `pptx`、`website-design-fast` 两个受管 Skill。禁止直接手写 `docker buildx` 发布 Web 镜像；统一使用：

```bash
pnpm release:web:check
pnpm release:web -- \
  --release YYYY-MM-DD-当前短提交-rN \
  --base-manifest deploy/releases/当前线上版本/release-manifest.json
```

脚本会校验本机 Skill 源目录与 `deploy/managed-web-skills.json` 完全一致，从已提交并推送的 `main` HEAD 创建干净暂存区，只注入清单内的 Skill，然后构建并推送 linux/amd64 镜像。推送后脚本会读取镜像内 `/srv/skills/index.json` 及每个 Bundle 再次验收，最后自动写入锁定摘要和准确 `gitCommit` 的 release manifest。缺少任一 Skill、出现额外目录、相关源码未提交、HEAD 未推送或镜像验收失败时都不会生成 manifest。

部署脚本同时上传 `internal.env`，并在切换 `/srv/mk/current` 前从 `mk-app` 容器验证 Web Skills、Runtime 和 ONLYOFFICE 三个内部 origin，再执行真实 PPTX 生成与结构检查。任一内部请求连接失败、发生重定向、状态码异常、Content-Type 不符或 PPTX 构建失败，部署直接失败。

`mk-app` 使用 `deploy/pptx-worker-seccomp.json`。该 profile 保留 Docker 默认拒绝策略，只额外允许参数精确等于 `CLONE_NEWUSER | CLONE_NEWNET` 的 `unshare`，供 PPTX 子进程建立无网络的嵌套 namespace；不得替换为 `seccomp=unconfined`，也不需要增加 `CAP_SYS_ADMIN`。

云端执行 SSH 的普通用户负责 `docker compose pull/up`，因此其 `~/.docker/config.json` 必须保存 GHCR 的只读登录；脚本仅在创建宿主持久目录、备份和初始化主密钥时使用 `sudo`。`/srv/mk/data/app` 与 `/srv/mk/secrets/mk_master_key` 会归容器 UID/GID `10001:10001` 所有，并保持 `0700`/`0600`，使非 root 的 `mk-app` 能写入数据、读取主密钥。

## 账号管理

正式域名部署会安装服务器命令 `/usr/local/bin/mk-user`。账号只能通过 SSH 管理，没有网页注册或网页账号管理入口。

```bash
sudo mk-user add admin
sudo mk-user list
sudo mk-user reset-password admin
sudo mk-user disable admin
sudo mk-user enable admin
sudo mk-user delete admin
```

`add` 和 `reset-password` 会要求无回显输入两次密码。`disable` 会立即撤销该账号的登录会话，但保留全部业务数据。`delete` 只有在逐字输入 `确认删除账号 <用户名>` 后才会永久删除账号、登录会话以及该账号的模型、Agent、会话、实验、Workspace、产物、文件和加密 API Key。

`list` 是不停服务的只读查询；其他修改命令会在输入完成后短暂停止 `mk-app`，完成账号文件的独占写入后自动恢复。Docker Compose 的创建、停止和启动过程保持静默，终端只显示账号结果或明确错误。
