# MCP 与 Agent Skills 开发设计

> 本文是 Models Kindergarten 的工程实现说明。第一次学习 MCP，请先阅读 [MCP 入门与产品能力手册](MCP_LEARNING_GUIDE.md)，理解 Host/Client/Server、最小 MCP 链路和能力分类后再看本文。

## 1. 边界

```text
Browser ──ACP──► Remote AgentRuntime
                    ├─ RuntimeCapabilityCatalog
                    │   ├─ Built-in ToolRegistry
                    │   ├─ McpToolProvider
                    │   └─ SkillToolProvider
                    ├─ ToolRuntime
                    └─ ContextAssembler

McpClientManager ──stdio / Streamable HTTP──► MCP Servers
SkillRegistry ──read only──► builtin / project / user skills
```

- ACP 负责 Browser 与 Agent 的聊天、Permission 和 Elicitation。
- MCP 负责 Remote 与外部 Server 的能力交换。
- Skills 是过程知识包，不拥有网络连接、Secret 或授权。
- 所有 MCP Tool 与 Skill Runtime Tool 必须经过 ToolRuntime。

## 2. MCP 数据分层

| 数据 | 模块 | 是否持久化 |
| --- | --- | --- |
| Server/Auth/Agent capability 配置 | `McpConfigStore` | 是，不含明文 Secret |
| Secret | `HostSecretStore` | 环境或 macOS Keychain |
| Client 与连接状态 | `McpClientManager` | 否 |
| Tool/Resource/Prompt 发现结果 | `McpCapabilitySnapshot` | 当前进程 |
| 当前 Turn 能力版本 | `RunCapabilitySnapshot` | 随 Runtime Trace |

配置示例见 `config/mcp.example.json`。缺少配置文件时只启用内置 Tool 和 builtin Skill，不会尝试连接外部 Server。

## 3. MCP 运行链

1. `McpConfigStore` 严格校验 Server ID、Transport、Auth 引用和 Agent capability allowlist。
2. `McpClientManager` 为每个 enabled Server 创建独立 Client。
3. SDK 以 `versionNegotiation.mode=auto` 协商 modern/legacy。
4. Manager 分别获取 Tools、Resources、Prompts；任一发现失败会保留失败状态，不伪装成空能力。
5. `McpToolProvider` 只暴露 Agent capability allowlist 中的 Tool，并编译完整 JSON Schema。
6. 模型 Tool Call 先进入 ToolRuntime，再调用具体 MCP Server。
7. MCP rich content 同时保留结构化输出、ACP ContentBlock 和给模型的结果 envelope。

同一 Server 的请求串行执行，使 legacy Elicitation 和现代 MRTR 都能确定性映射到当前 Tool Call。MRTR 的 form 请求通过现有 ACP AskUser 获取一个文本值；多字段表单当前只填写首个 required 字段，URL 模式展示 URL 并等待用户确认。

## 4. 网络与鉴权

- stdio 使用官方 Client，并由 macOS `sandbox-exec` 包装；默认只访问沙箱目录、禁止网络、使用安全环境白名单。
- 额外读写路径和网络必须在 Server 配置中显式声明。
- Streamable HTTP 生产地址必须 HTTPS；loopback 开发地址允许 HTTP。
- 默认拒绝私网、link-local、保留地址和自动重定向，响应上限 4 MiB。
- Bearer/API Token 通过 `SecretRef` 读取；Authorization Header 不能用普通 headerRefs 绕过 AuthBroker。
- `oauth` 配置当前消费已经完成外部授权并安全保存的 Access Token；浏览器授权和刷新 UI 不在聊天链路中实现。

## 5. Skills 生命周期

```text
source
  → quarantine
  → 路径/符号链接/数量/大小校验
  → SKILL.md YAML 与命名校验
  → 全目录 SHA-256
  → 原子发布
  → skills-lock.json
```

安装命令：

```bash
pnpm --filter @kindergarten/remote skill:install -- \
  --source local --path /absolute/path/to/skill --approve

pnpm --filter @kindergarten/remote skill:install -- \
  --source git --url https://github.com/example/skills.git \
  --ref <commit-or-tag> --subdir skills/example --approve
```

Git 安装最终记录解析后的 40 位 Commit。安装过程不会运行 lifecycle 或 Skill scripts；同名 Skill 直接拒绝，内容与 lock Hash 不一致时 Remote 启动失败。

运行时只把 Skill `id/name/description/trust` 放入 `skill_catalog`。模型通过：

- `activate_skill(skill_id)` 读取完整 SKILL.md；
- `read_skill_resource(skill_id, path)` 按需读取 references/assets/scripts 中的文本。

`allowed-tools` 只保留为实验性需求声明，不会授予权限。Skill scripts 当前可以被读取，但不会自动执行。

## 6. 上下文与可复现性

`ContextAssembler` 保持三类来源：

- SessionEntry 事实历史；
- Skill metadata catalog；
- MCP Resource catalog 与显式 preload 数据。

MCP Resource 以 user/data 消息进入，并包裹不可信数据标记。MCP Server instructions 不会自动拼入 Core System Prompt。每次 Prompt Turn 在开始时冻结 Tool definitions 和 capability snapshot；连接或目录变化只影响下一 Turn。

Runtime Trace 的 variant 保存：

- 每个 Tool 的 origin 与 schemaHash；
- MCP Server protocolEra、capability revision、Tool Schema Hash；
- Skill ID、contentHash 和来源。

## 7. 当前实施边界

已实现：stdio、Streamable HTTP、modern/legacy 协商、Tools、Resources、Prompts 发现、MRTR/Elicitation、SecretRef、能力 allowlist、Skills 本地/Git 安装、渐进加载和 Turn 能力快照。

未实现：旧 HTTP+SSE、Roots/Sampling/Logging、Tasks、MCP Apps、Registry 市场 UI、OAuth 浏览器授权 UI、通知订阅、Skill 自动更新、依赖安装和脚本自动执行。
