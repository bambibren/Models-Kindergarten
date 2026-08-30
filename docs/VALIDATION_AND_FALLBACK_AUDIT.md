# 全仓库校验与兜底逻辑审计

> 审计日期：2026-08-13  
> 范围：`apps/*/src`、`packages/*/src` 中的输入拒绝、固定上限、静默规范化、默认值、自动重试与降级逻辑。测试代码只用于确认行为，不作为需求依据。  
> 判定原则：需求文档或用户明确决策能直接支持的为“明确需求”；防止越权、SSRF、Secret 泄露、路径逃逸、持久化损坏的为“必要安全边界”；其余固定数字、启发式和静默修正列为“缺少需求依据”。

## 结论

本轮发现 13 组缺少明确需求依据的逻辑，其中 7 组会实际改变产品结果或误导用户，建议优先调整；另有 8 组校验属于明确需求或必要安全边界，应保留。

## 2026-08-30 受管端点环境策略补充

- `local-source`：Model Provider 与 Remote MCP 不做公网、私网或保留 IP 分类，允许 VPN Fake-IP、loopback 和局域网地址。
- `docker-preview`、`cloud`：Model Provider 与 Remote MCP 继续只允许公网目标。
- 所有环境继续验证 URL 语法、URL 凭据、协议、重定向、响应大小和超时。自定义公网模型仍要求 HTTPS；本机 Ollama 使用独立协议。
- `web_fetch` 始终阻止本机和私网，因为目标由模型选择；本地开发身份可以访问 Control API，取消该边界会形成工具越权。
- Skill 来源白名单、文件沙箱、服务监听地址和 Cloud 部署目标校验不属于本地出站 IP 兼容问题，继续保留。

## A. 建议优先调整：会改变结果或掩盖事实

| 编号 | 位置 | 当前程序行为 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| A-01 | `apps/remote/src/experiments/annotation-worksheet-generator.ts` | 模型分段发生跳号、重叠或分段数过多时，服务端静默移动边界、合并标签，使结果强行连续。 | 这是服务端替模型改答案，页面看不出原始生成已无效；没有需求授权这种“修好后当成功”。 | 严格校验并把该次生成标为失败，允许用户重新生成；不要静默修复语义结果。 |
| A-02 | `apps/remote/src/experiments/experiment-service.ts` | Evaluation API 缺字段时，把权限违规、重复调用、Token 等指标默认成 `0/false`；API 不可用时改用内存 Trace。 | “未采集”被写成“没有发生”，会抬高 Runtime 分；来源切换也没有体现在评分可信度中。 | 缺失字段保持 `undefined`，关键指标不完整时不出总分；内存 Trace 明确标注来源和完整度。 |
| A-03 | `packages/contracts/src/experiments.ts` | Runtime 100 分公式、各指标权重 `30/25/15/15/5/10`、失败最高 59 分、同组相对速度排名均为固定代码。 | 用户只要求 Runtime metrics 参与第四维，没有确认这套具体权重和相对评分算法。 | 把公式作为待确认产品规则并配置化；确认前页面展示原始指标或明确标“暂定公式”。 |
| A-04 | `apps/remote/src/tools/tool-runtime.ts` | 同一 Turn 内只要工具名和参数相同，后续调用一律作为重复调用阻止，并复用第一次结果。 | `read_file` 在 `write_file` 后再次读取、网络状态变化后重试等都可能是合理调用；当前去重键没有状态版本。 | 只对明确幂等且无状态变化的调用去重，或只阻止仍在运行的完全重复调用。 |
| A-05 | `apps/remote/src/capability/runtime-capability-resolver.ts` | `recent_turns=N` 被换算为最多 `N * 8 + 1` 条消息。 | 一个 Turn 不等于固定 8 条消息；工具多时会截断，工具少时又会带入超过 N 个 Turn 的内容。 | 按 `turnId` 选择最近 N 个完整 Turn，再让 ContextAssembler 按 Token 预算裁剪。 |
| A-06 | `apps/web/src/evaluation/experiment-acp-client.ts` | 实验运行遇到权限请求时，客户端自动选择 `allow_once`；表单询问也会自动用第一个字段提交预设答案。 | 实验在无人确认时替用户授权，且可能改变被测 Agent 的真实行为。 | 实验策略显式定义权限处理；需要人工时暂停 lane，不要暗中代答。 |
| A-07 | `apps/web/src/product/HomePage.tsx` | 生产首页用提示词是否包含 `ensure_agent_skills` 和 `frontend-design` 判断“网站开发任务”。 | 这是 Demo 文案耦合，不是业务状态；用户改写提示词后 UI 行为会漂移。 | 模板点击时写显式 UI 状态，或完全不需要识别任务类型。 |

## B. 缺少需求依据的固定限制或默认策略

| 编号 | 位置 | 当前程序行为 | 审计判断 | 建议 |
| --- | --- | --- | --- | --- |
| B-01 | `apps/remote/src/skills/skill-validator.ts` | 单 Skill 最多 200 文件、总计 2 MiB、单文件 256 KiB；任何隐藏文件都拒绝；可执行文件只能位于 `scripts/`；frontmatter `name` 必须等于目录名。 | 安全上需要资源上限，但具体数值、隐藏文件全拒绝、目录名相等并无当前需求依据，可能误杀合法 Skill。 | 保留可配置的总大小/文件数防护；依据支持的 Skill 规范逐条确认其他限制，不要把本项目习惯当通用格式。 |
| B-02 | `apps/remote/src/skills/skill-installation-service.ts` | 每个安装任务最多 10 个 URL。 | 防滥用有意义，但 10 是未说明的产品数字。 | 配置化并在 UI 提前展示；单目录规则下可先允许页面分批提交，而非格式错误。 |
| B-03 | `apps/remote/src/session/session-launch-service.ts` | Prompt 最多 100000 字符；启动草稿固定 24 小时过期。 | 都是实现时自行选择的数字。 | 改为配置并在接口合同/UI 中说明；过期属于生命周期而非格式校验。 |
| B-04 | `apps/remote/src/mcp/mcp-management-service.ts` | MCP 连接测试结果固定 10 分钟过期。 | 重新验证是合理的，但 10 分钟没有产品依据。 | 配置化并把过期时间展示给用户。 |
| B-05 | `packages/contracts/src/agent-management.ts` 与 `packages/contracts/src/common.ts` | 名称、说明、system prompt、URI 等使用多个固定字符上限，并对所有字符串先 `trim()`。 | 资源保护需要上限，但具体数字未形成产品合同；`trim()` 会静默改变系统提示词的首尾空白。 | 把限制集中为合同常量；标识符可 trim，Prompt 正文保持原文。 |
| B-06 | `apps/remote/src/tools/process-sandbox.ts`、`web-access.ts` | 命令 30 秒、输出 64 KiB、网页 512 KiB、最多 5 次重定向、请求 12 秒、最多 10 条搜索结果。 | 属于运行资源预算，不是格式真伪；当前数字是工程默认值。 | 保留防失控能力但配置化，超限应返回“资源限制”而非“格式异常”。 |

## C. 明确需求或必要安全边界：建议保留

| 位置 | 行为 | 保留原因 |
| --- | --- | --- |
| Skill 来源与安装 | 只允许当前用户消息明确给出的 GitHub URL；从 URL 指向目录按层查找，只安装第一次出现 `SKILL.md` 的深度，找到后不继续深入。 | 用户明确决策。既不写死 `tree/skills`，也不会把 Skill 内部渐进资源误装成子 Skill。 |
| `skill-installer.ts` / `skill-validator.ts` | 固定 Git commit、禁止路径越界和符号链接逃逸、不执行 Skill 自带脚本。 | 防止安装后内容漂移与宿主文件越权。 |
| `session-binding-service.ts` | 浏览器 `mcpServers=[]`，MCP 只来自已安装并绑定的 Agent；`additionalDirectories` 首版为空。 | 当前受管能力模型的明确设计，防止客户端绕过绑定。 |
| MCP URL 网络策略 | 拒绝 URL 凭据、限制协议并逐跳检查重定向；`docker-preview`/`cloud` 额外阻止私网地址。 | 重定向和凭据限制防止 Secret 泄露；私网 IP 分类只在线上型部署启用，源码本地开发允许用户配置任意网络。 |
| MCP `auth=none` | 页面/API 暂不写入 Bearer Token。 | 用户明确要求 Bearer 小说 MCP 留白。 |
| 文件与命令沙箱 | 相对路径、真实路径复核、拒绝跨 workspace、命令执行需隔离。 | 防止模型访问或修改产品范围外文件。 |
| 实验 2～3 lanes | 对照实验只允许 A/B/C，fresh 至少存在两种不同策略，history A 复用原始快照。 | Demo 交互和既有方案均明确表达此产品形态。 |
| 人工标注 | 模型只生成需求合并、工作流提取和结果分段，不生成 verdict/分数/winner。 | 用户明确要求人工注释量表，不要自动评分调用。 |

## D. 这次 Skill 失败的准确归因

1. `.git` 仓库地址已通过来源与用户授权校验，程序已经进入真实 `git clone`。
2. 截图中的失败是连接 GitHub 443 端口 75 秒超时，不是格式异常。
3. 随后用相同地址重试克隆成功，证明它是临时网络失败。
4. `greensock/gsap-skills` 根目录没有 `SKILL.md`；第一次发现 `SKILL.md` 的深度包含 `skills/gsap-*` 这 8 个目录。依照最新规则，根地址会安装这 8 个 Skill，不继续进入它们的资源子目录。
5. 下载错误现已转换成可重试的简明业务错误，不再向页面暴露本机临时目录和完整 Git 命令。

## 建议处理顺序

1. 先移除 A-01、A-02、A-04、A-06 的静默改写或代替用户决策。
2. 单独确认 A-03 的 Runtime 评分公式；这是产品规则，不应由实现自行决定。
3. 修正 A-05 与 A-07 的 Demo 启发式耦合。
4. 将 B 类数字集中为可配置资源预算，并统一改成准确的“超限/过期”错误，不再混作格式异常。
5. 保留 C 类安全边界，除非产品威胁模型发生变化。
