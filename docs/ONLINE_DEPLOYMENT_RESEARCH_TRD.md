# Models Kindergarten 在线部署技术设计

> 日期：2026-08-29
> 状态：当前唯一部署方案；待第二阶段实施
> 适用范围：本机云端预演、单机云部署、少量同权限账号低并发使用

---

## 一、部署结论

MK 首版不需要 Kubernetes、Redis、消息队列、多机 Remote、云数据库或自建模型服务器。

```text
开发态
└─ macOS 宿主机
   ├─ pnpm dev
   ├─ Web：Vite + HMR
   ├─ Remote：Node/tsx watch + 调试器
   ├─ Evaluation 模块：随 Remote 同进程运行
   ├─ .data：本地开发数据
   └─ 模型：统一由入园配置连接外部 API

云端预演与正式部署
└─ 同一套 Compose 拓扑
   ├─ mk-web         Web / Gateway 自有镜像
   │  ├─ Caddy
   │  ├─ Web 静态产物
   │  └─ Skills 静态资源
   ├─ mk-app         Runtime 自有镜像
   │  ├─ Remote Node ESM bundle
   │  ├─ Agent Runtime
   │  └─ Evaluation 模块
   └─ mk-onlyoffice  官方 ONLYOFFICE 镜像
```

本机日常开发不进入 Docker；只有验证真实构建产物、Linux 行为、持久卷、Secret、同源路由、健康检查和部署回滚时，才启动云端预演 Compose。

云端不部署 Ollama。开发和生产都通过统一的模型入园配置连接模型 API；如果本机临时使用免费小模型，也只把 Ollama 当作一个可删除的 API Provider，不产生不可删除的默认模型。

---

## 二、镜像与容器

### 2.1 两份 MK 自有镜像

```text
mk-web:<commit-sha>
├─ 固定摘要的 Caddy 基础镜像
├─ apps/web/dist
├─ 允许打包的 Skills 静态资源
└─ Caddyfile

mk-runtime:<commit-sha>
├─ apps/remote/dist
├─ builtin skills
├─ production dependencies
└─ mk-app 启动入口：Remote + Evaluation 模块
```

MK 构建、测试和发布 `mk-web`、`mk-runtime` 两份镜像。构建 `mk-web` 时从主仓库工作目录的 `resource/skills` 复制允许打包的 Skills；这些来源待确认的文件由 Git 忽略，因此最终镜像在持有资源文件的受控本机完成构建。运行时不启动独立资源服务。ONLYOFFICE 直接使用官方镜像。

### 2.2 三个部署镜像与三个容器

```text
镜像（安装包/模板）                    容器（运行实例）
──────────────────────────────────────────────────────────
mk-web:<不可变摘要>              ───>  mk-web
mk-runtime:<不可变摘要>          ───>  mk-app
onlyoffice/documentserver:<摘要> ───>  mk-onlyoffice
```

划分原因：

- `mk-web` 独立提供 Web 与 Skills 静态文件、公网 80/443、TLS、同源转发和访问日志；
- `mk-app` 只运行 Remote、Agent Runtime 与 Evaluation 模块，不提供 Web 静态文件；
- `mk-onlyoffice` 是大型第三方服务，有自己的进程、依赖、健康状态与升级周期；它故障时 MK 静态预览仍可使用。

Web 与 Remote 不在同一容器。Skills 与 Web 同为只读静态内容，由 Caddy 直接提供，不需要 Node 进程、独立端口或持久卷。

---

## 三、请求与数据架构

```text
浏览器
  │
  │ HTTPS / WSS：仅公开 80、443
  ▼
mk-web（Caddy + Web 静态产物 + Skills 静态资源）
  ├─ /、/evaluation/* ───────────────> 本容器直接返回页面
  ├─ /api/control/v1/*、/acp ────────> mk-app
  ├─ /api/evaluation/v1/* ───────────> mk-app 内 Evaluation 模块
  ├─ /skills/* ──────────────────────> 本容器静态目录
  └─ /office/* ──────────────────────> mk-onlyoffice

mk-app
  └─ Remote
     ├─ HTTP Control API / ACP WebSocket
     ├─ Session / Agent Runtime
     ├─ Model Provider
     ├─ Tool / Skill / MCP Runtime
     ├─ Artifact / Workspace
     ├─ Secret / Storage
     └─ Evaluation 模块
           │
           ├─ HTTPS ──> 外部 8B/其他模型 API
           └─ 签名票据 ──> mk-onlyoffice
```

```text
用户消息中的 Skill 地址
└─ SKILL_RESOURCE_ORIGINS 校验公开源站
   ├─ 源码开发：http://127.0.0.1:5173
   ├─ Docker 预演：https://mk.localhost
   └─ 云端生产：https://正式域名
             │
             └─ 保留 /skills/{name} 路径
                        │
                        ▼
Remote 实际下载
└─ SKILL_RESOURCE_FETCH_BASE
   ├─ 源码开发：http://127.0.0.1:7342
   └─ Docker / 云端：${MK_WEB_INTERNAL_ORIGIN}
      ├─ deploy/env/internal.env 统一配置
      ├─ 纯 HTTP 内网站点
      └─ 不发布宿主机端口、禁止重定向
```

```text
持久卷 mk-app-data
└─ /data
   ├─ sessions / agents / models / contexts
   ├─ evaluation
   ├─ artifacts
   ├─ workspaces
   ├─ auth
   └─ encrypted-secrets

持久卷 mk-onlyoffice-data
└─ DocumentServer 自身数据、缓存和日志
   └─ 不是 MK Artifact 的事实来源，可按官方升级方式维护
```

首版不需要为 Evaluation、Artifact 和 Workspace 分成三个 Docker 卷。它们都由同一个 `mk-app` 进程管理，统一挂载 `/data` 更容易备份和恢复；目录边界仍保留。只有未来改成独立存储服务或需要不同容量、权限、备份周期时才拆卷。

---

## 四、Evaluation 模块

```text
一次 Agent Turn
  │
  ├─ 正式结果 ──> Session / Turn Repository
  │
  └─ RuntimeObservation
        │
        ▼
     Evaluation 模块
        ├─ 异步收集 Trace
        ├─ 计算确定性评测
        ├─ 写入 /data/evaluation
        └─ 由同一 Remote HTTP Server 提供查询
```

约束：

- Evaluation 不是独立服务、进程、端口、容器或镜像；
- 浏览器通过 `GET /api/evaluation/v1/turn-evaluations/:sessionId/:turnId` 查询；
- 查询沿用 Remote 登录身份和数据归属校验；
- 写入失败只让 Evaluation 降级，不得把已完成的 Agent Turn 改成失败；
- Evaluation 不需要跨进程 HTTP Token、单独服务地址或第二个后端端口。

---

## 五、身份、登录与请求身份

### 5.1 登录配置

```text
云主机提供
├─ Linux 机器
├─ 公网 IP
└─ 安全组 / 防火墙

部署者准备
├─ 域名并把 DNS 指向公网 IP
├─ 至少一个可登录账号
├─ MK 主密钥
└─ Provider API Key

Caddy 在域名可达后
└─ 自动申请和续期 TLS 证书
```

云服务器不会自动给 MK 建立用户身份或业务域名。它只提供运行环境和网络入口；账号、认证库和域名由部署脚本生成或由部署者提供。

### 5.2 Remote 请求身份（Principal）

```text
随机 Session Token Cookie / ACP WebSocket Upgrade
              │
              ▼
Remote 校验登录会话
              │
              ▼
创建本次请求或连接的 Principal
├─ 账号标识
└─ 登录会话标识
              │
              ▼
Session、Artifact、Evaluation、Agent、Model 等操作
统一进行账号数据归属校验
```

Principal 不是一个服务，也不是模型 Provider。它只是 Remote 在完成登录校验后，为当前 HTTP 请求或 ACP 连接创建的“已确认账号身份”，防止一个账号读取或修改另一个账号的数据。账号之间使用相同产品能力，不设置 Admin/Guest 权限等级。

登录成功后，浏览器 Cookie 保存随机 Session Token，认证库保存 Token 哈希、账号和过期时间；Remote 查到登录会话后构造 Principal。

---

## 六、Secret 与主密钥

```text
本地源码开发
├─ .local/secrets/mk_master_key       仅当前系统账号可读，0600
├─ .data/secure/credentials.enc       加密后的 Provider API Key
└─ Remote 读取两者后在内存中解密使用

Docker 预演 / 云端
├─ /run/secrets/mk_master_key         只读挂载，目标 0400 或 0600
├─ /data/secure/credentials.enc        持久卷中的加密文件
└─ 同一套 Remote 解密逻辑
```

`mk_master_key` 是“保险柜总钥匙”，Provider API Key 是“保险柜里的业务凭据”。加密和解密由 Remote 的 `SecretStore`/Vault 代码完成，不依赖 Docker 提供解密能力。

Linux 文件权限数字：

```text
0400  文件所有者只读；组和其他用户无权限
0600  文件所有者可读写；组和其他用户无权限
0444  所有者、组、其他用户都可读；所有人都不可写
```

当前安全校验拒绝“组用户或其他用户可读”的主密钥文件，是因为它保存的是能解开全部 API Key 的总钥匙。Compose Secret 规范默认模式是 `0444`，意味着容器内任何账号理论上都可读；这与 MK 的最小权限校验冲突。Docker 官方还说明，本地 Compose 使用 `file:` Secret 时底层是 bind mount，声明的 UID/GID/mode 会被忽略。第二阶段必须在 Docker Desktop 和真实 Linux 上检查挂载后的所有者和 mode：文件来源先收紧宿主源文件并匹配 `mk-app` UID，平台 Secret 则使用平台真正支持的所有者映射，不能只写一行 Compose 配置就假设权限正确。

---

## 七、云端 Linux 上各类 Tool Call 的运行条件

它们在产品层都通过 Tool Call 被 Agent 调用，但底层执行方式和风险不同：

```text
Tool Call
├─ 文件型工具
│  └─ 只读写当前 Session Workspace；首发开启
├─ HTTP MCP
│  └─ 发出网络请求；按域名白名单和凭据边界开启
├─ run_command
│  └─ 创建任意系统进程；Linux 隔离执行器完成前关闭
├─ stdio MCP
│  └─ 启动本地 MCP 子进程；Linux 隔离执行器完成前关闭
└─ build_pptx
   └─ 启动 PPTX 构建进程并读写文件；隔离验收通过后开启
```

“Linux 工具能力”不是另一套 Tool 协议，而是在说明：这些 Tool Call 到云端后是否有安全、可复现的 Linux 执行环境。纯文件逻辑、受控 HTTP 请求和任意进程执行不能用同一风险等级处理。

隔离验收至少验证：非 root、只挂当前 Workspace、根文件系统只读、无 Docker Socket、无业务 Secret、默认断网、进程/CPU/内存/超时限制，以及任务结束后临时执行环境可销毁。未通过就保持功能关闭，不退化为在 `mk-app` 容器中裸执行。

---

## 八、本机云端预演

```text
pnpm dev
└─ 验证源码开发体验
   ├─ HMR
   ├─ watch
   ├─ 断点调试
   └─ 本地 .data

pnpm preview:cloud（第二阶段新增）
└─ 验证真实发布形态
   ├─ pnpm install --frozen-lockfile
   ├─ typecheck + test + build
   ├─ 构建 mk-web 与 mk-runtime 镜像
   ├─ 将 resource/skills 中允许打包的 Skills 写入 mk-web
   ├─ 启动与云端一致的 Compose
   ├─ 使用独立 preview 数据卷
   ├─ 通过本机 HTTPS/同源入口访问
   └─ 执行登录、ACP、Evaluation、Artifact、PPTX 冒烟测试
```

两套环境共享 MK 源码、构建脚本、Dockerfile 和 Compose 拓扑；发布构建读取主仓库工作目录中的 `resource/skills`，但不共享运行数据。预演不会把开发态 `.data` 当作生产卷，也不会让 Vite/tsx 进程假装成发布产物。

---

## 九、CI/CD 与不可变镜像

```text
提交代码
  │
  ▼
CI 安装锁定依赖
  │
  ├─ 类型检查
  ├─ 单元/集成测试
  └─ 构建 Web 与 Remote
  │
  ▼
受控本机发布构建
  │
  ├─ 选择已通过 CI 验证的 MK Git Commit
  ├─ 从主仓库 resource/skills 复制允许打包的 Skills
  ├─ 构建 mk-web 与 mk-runtime 镜像
  ├─ 记录 commit SHA
  ├─ 计算镜像 digest：sha256:...
  ├─ 校验 mk-web 内 Web 与 Skills 静态资源
  ├─ 对三个容器做健康检查和冒烟测试
  └─ 通过后推送两份自有镜像到私有镜像仓库
  │
  ▼
本机云端预演与正式云端
都拉取同一组 digest
```

镜像 Tag 可以被重新指向，例如 `latest` 或 `production`；digest 是镜像内容的密码学指纹，内容一变 digest 就变。生产部署只接受已经通过测试的 digest，不在云主机现场重新安装依赖或重新构建，否则“测试过的”和“真正上线的”可能不是同一份内容。

回滚就是把 Compose 中的 `mk-web`、`mk-runtime` 和 ONLYOFFICE 切回上一组已验收摘要；持久数据是否回滚由数据迁移兼容性单独决定。

---

## 十、启动、健康与故障边界

```text
启动顺序
1. 校验持久卷和 Secret 权限
2. 启动 mk-onlyoffice，等待自身健康
3. 启动 mk-app，完成数据恢复与迁移
4. 启动 mk-web，发布 Web、Skills、HTTPS/WSS 与同源路由
5. 执行登录、ACP、Evaluation、Skill 安装、Artifact、PPTX 冒烟测试
```

```text
检查层次
├─ 进程存活：Node 是否仍运行
├─ Remote 就绪：主数据和路由可用
├─ Evaluation 状态：ready / degraded
├─ 外部模型 Provider：可达或明确不可用
├─ ONLYOFFICE：只影响动画播放
└─ 浏览器冒烟：HTTPS、Cookie、WSS、同源路由
```

Evaluation 模块内部写入或评分失败时必须降级，不能把已经完成的 Agent Turn 改成失败；ONLYOFFICE 或某个模型 Provider 故障也不能让静态 Web、历史浏览和其他健康能力全部下线。但 `mk-app` 进程整体崩溃仍会同时影响 Remote 与 Evaluation。认证库、可登录账号、公开域名或 TLS 配置缺失时必须拒绝以生产模式启动。

---

## 十一、实施清单

### P0：本机云端预演前

- [ ] `mk-web` 独立包含 Caddy、Caddyfile、Web 与 Skills 静态资源；
- [ ] `mk-app` 只运行 Remote、Agent Runtime 与 Evaluation 模块；
- [ ] `resource/` 在源码开发时提供 7342 服务，在镜像构建时只作为 `mk-web` 静态资源输入；
- [ ] Remote 容器监听 `0.0.0.0:7331`，宿主开发继续监听 loopback；
- [ ] Vite 与生产统一使用 `/api`、`/acp`、`/evaluation` 同源地址；
- [ ] 增加登录、请求身份和账号数据归属隔离；
- [ ] 增加文件型主密钥加载及容器权限验收；
- [ ] `/data` 挂载独立 preview 持久卷；
- [ ] 增加 Web/Runtime Dockerfile、Compose、Caddyfile、健康检查与冒烟脚本；
- [ ] 云端禁用 Ollama 与不可删除默认小模型；
- [ ] `run_command`、stdio MCP、`build_pptx` 按 Linux 隔离结果显式开关。

### P0：正式部署前

- [ ] 购买/准备云主机与域名，DNS 指向公网 IP；
- [ ] 只开放公网 80/443，7331 不直接公开；
- [ ] 初始化认证库、MK 主密钥和登录账号；
- [ ] Caddy 成功申请 TLS，HTTP 自动跳转 HTTPS；
- [ ] 固定 mk-web、mk-runtime、ONLYOFFICE 三个部署镜像摘要；
- [ ] 备份、恢复和回滚演练通过；
- [ ] 不同账号之间的数据越权测试全部拒绝；
- [ ] 外部 8B API、ACP、Evaluation、Skill 安装、HTML/PPTX 产物全链冒烟通过。

---

## 十二、升级触发条件

```text
当前：单个 mk-app 实例 + 单持久卷
  │
  ├─ 持续活跃用户 > 10 或事件循环成为瓶颈
  │  └─ 评估第二个 Remote 与共享状态
  │
  ├─ 必须无维护窗口
  │  └─ 引入双实例、WebSocket 粘性路由
  │
  ├─ 多实例需要同时写业务数据
  │  └─ 元数据迁移 PostgreSQL，Blob/Workspace 迁移对象存储
  │
  ├─ 长任务不能依赖 Remote 生命周期
  │  └─ 独立 Worker + 持久任务队列
  │
  └─ 文档播放负载独立增长
     └─ ONLYOFFICE 迁移独立主机或托管服务
```

在这些真实触发条件出现前，不提前引入 Kubernetes、Redis、Kafka 或托管 PostgreSQL。

---

## 参考代码

- [Remote 启动](../apps/remote/src/index.ts)
- [Remote HTTP/ACP 网络层](../apps/remote/src/server/http-server.ts)
- [Evaluation 模块](../apps/remote/src/evaluation/evaluation-module.ts)
- [Evaluation Trace 收集](../apps/remote/src/evaluation/trace-collector.ts)
- [Session Repository](../apps/remote/src/repository/session-repository.ts)
- [主密钥文件加载](../apps/remote/src/secrets/file-master-key.ts)
- [环境变量示例](../.env.example)
