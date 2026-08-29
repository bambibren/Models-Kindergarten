# MK Resource

为 Models Kindergarten 提供源码开发时的只读 Skill 资源包。它是主仓库的 `resource` 工作区，不是生产容器。

```bash
pnpm dev:resource
```

服务实际监听 `http://127.0.0.1:7342`。日常使用根级 `pnpm dev` 同时启动 Web、Remote 和 Resource；Vite 将公开的 `/skills/*` 请求代理到该端口。

```text
http://127.0.0.1:5173/skills/website-design-fast
```

源码开发配置：

```bash
SKILL_RESOURCE_ORIGINS=http://127.0.0.1:5173
SKILL_RESOURCE_FETCH_BASE=http://127.0.0.1:7342
VITE_RESOURCE_DEV_TARGET=http://127.0.0.1:7342
```

把 5173 同源地址放进用户消息，Agent 即可通过统一的 Skill 安装工具下载、校验并绑定。Docker 与云端由 `mk-web` 中的 Caddy 直接提供 `/skills/*`，不启动本服务。

服务只读取 `skills/` 下的目录，不执行 Skill 中的脚本，也不允许通过路径访问任意文件。
