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

该命令创建独立主密钥，构建 `mk-web` 和 `mk-runtime`，启动 `mk-web`、`mk-app`、`mk-onlyoffice`，并自动验证 Web、API、Evaluation、Skills、ACP、ONLYOFFICE、非 root、Secret 权限和数据重启持久化。

```bash
pnpm deploy:preview:smoke
pnpm deploy:preview:down
```

预演数据位于 `deploy/local/data`，主密钥位于 `deploy/local/secrets`，二者均不进入 Git 或镜像。

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

云端命令只通过 SCP 上传 Compose、环境文件和 release manifest；镜像由云服务器从私有 GHCR 按摘要拉取，业务数据和主密钥保存在 `/srv/mk/data` 与 `/srv/mk/secrets`。

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
