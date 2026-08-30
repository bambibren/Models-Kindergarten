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
  --manifest deploy/releases/版本/release-manifest.json
```

云端命令只通过 SCP 上传 Compose、环境文件和 release manifest；镜像由云服务器从私有 GHCR 按摘要拉取，业务数据和主密钥保存在 `/srv/mk/data` 与 `/srv/mk/secrets`。
