# Skill Context V1 模型矩阵测试报告

测试日期：2026-08-14（Asia/Shanghai）

## 1. 结论

V1 通过，不进入 V2。

按实测期间确认的最终验收口径，一个测试格同时满足以下条件即为功能通过：

1. 实际写出包含气泡水网站实现的 HTML；
2. 至少成功调用一个来自 `greensock/gsap-skills` 的 Skill；
3. 至少成功调用 `frontend-design`、`design-brief`、`impeccable-design-polish` 三者之一。

结果为 4/6 功能通过：千问 8B 的 fast、balanced 未通过；大聪明的 fast、balanced、deep、max 均通过。max 的功能验收通过，但 Turn 最终撞到 24 次模型请求上限，必须单独标记为运行终态问题。

## 2. 冻结输入与上下文版本

- 固定用户提示词长度：485 个 JavaScript 字符；测试脚本未对文字做 trim、补写或改写。
- 固定提示词 SHA-256：`63a534e6bc2269078c2016676aad66df29ade6ad76544d4d7ef2c50b6db28dc0`。
- Runtime Skill 上下文版本：`MK_SKILL_CONTEXT_VERSION=v1`。
- V1 固定协议长度：301 个 JavaScript 字符。
- V1 固定协议 SHA-256：`5a9b8c01f2b3876f867245a371b99eb74ed74a5cb169aa426ac75b0a86252642`。
- 测试 Agent：`f69525b9-96b3-4436-b04e-906bb99d13a8`。
- 每个测试格开始前都把该 Agent 的 Skill 绑定重置为空；Session 创建后再发送同一固定提示词。因此每格都真实经过 `ensure_agent_skills` 和 capability generation 1 → 2，而不是继承上一格已绑定目录。
- 四个 URL 安装后对应 11 个实际 Skill：三个单 Skill 与 GSAP 根仓发现的八个 Skill。最终验收按来源分类，不虚构名为 `gsap-skills` 的单一 Skill。

## 3. 矩阵结果

| 模型 | 档位 | Session / Turn | 终态与轮数 | 成功激活 | 产物 | 功能验收 |
|---|---|---|---|---|---|---|
| 千问 8B | fast，`think=false` | `96dada3b-ee2c-4086-a7e0-9ad1ce8311fc` / `e5bfd6a4-384c-42ac-90ce-9f439eb1a6eb` | failed，4 轮；`EMPTY_ASSISTANT_RESPONSE` | `frontend-design`；第一次错传 `skill_name`，一次纠错后成功 | 无 | 失败 |
| 千问 8B | balanced，`think=true` | `b6d66376-b8e5-47ad-a611-bd7992dadf9a` / `5b8e9ef3-03a0-4b26-a4d3-8786523960ac` | completed，4 轮 | `frontend-design`；第一次错传 `skill_name + parameters`，一次纠错后成功 | 无；最终输出与气泡水无关的设计建议 | 失败 |
| 大聪明 | fast / low | `3a96556d-d95f-44fa-a427-894f8d0a5192` / `682f8644-5297-44b3-a32f-c4fa0fb4f398` | completed，12 轮 | `frontend-design`、`gsap-core`、`gsap-scrolltrigger`、`gsap-timeline`、`impeccable-design-polish` | `index.html`，16,090 bytes | 通过 |
| 大聪明 | balanced / medium | `0b0c3945-e6b4-44ad-8dc8-bc7cb83a1f75` / `31a6e9eb-d299-4192-9418-b4be6852bcfa` | completed，20 轮 | `frontend-design`、`gsap-core`、`gsap-scrolltrigger`、`gsap-performance`、`gsap-timeline`、`impeccable-design-polish` | `index.html`，26,214 bytes | 通过 |
| 大聪明 | deep / high | `6ab34c26-365d-44bd-8760-c5ddf587b878` / `08169ecd-bde8-4776-9417-9f1aeae645c8` | completed，22 轮 | `frontend-design`、`gsap-core`、`gsap-scrolltrigger`、`gsap-performance`、`gsap-timeline`、`impeccable-design-polish` | HTML/CSS/JS，47,050 bytes | 通过 |
| 大聪明 | max / xhigh | `c06baa29-ee3e-4064-823c-843b3b114cab` / `c4b55292-77a2-45f6-974a-3bac69623dfe` | failed，24 轮；`TURN_MODEL_ROUND_LIMIT` | `frontend-design`、`gsap-core`、`gsap-scrolltrigger`、`gsap-timeline`、`gsap-performance`、`impeccable-design-polish` | HTML/CSS/JS，59,989 bytes | 功能通过；运行终态失败 |

四个大聪明产物都包含四种口味、游戏、鼠标或 pointer 液体反馈和 GSAP 代码。fast 的 slogan 在 HTML 中由父文本与 `<span>` 拆分，浏览器渲染文字仍为“快来一起做汽水课间操！”。

## 4. 可点击产物

- 大聪明 fast：[index.html](/Users/bones/develop/Models-Kindergarten/apps/remote/.data/workspaces/3a96556d-d95f-44fa-a427-894f8d0a5192/index.html)
- 大聪明 balanced：[index.html](/Users/bones/develop/Models-Kindergarten/apps/remote/.data/workspaces/0b0c3945-e6b4-44ad-8dc8-bc7cb83a1f75/index.html)
- 大聪明 deep：[index.html](/Users/bones/develop/Models-Kindergarten/apps/remote/.data/workspaces/6ab34c26-365d-44bd-8760-c5ddf587b878/index.html)、[styles.css](/Users/bones/develop/Models-Kindergarten/apps/remote/.data/workspaces/6ab34c26-365d-44bd-8760-c5ddf587b878/styles.css)、[script.js](/Users/bones/develop/Models-Kindergarten/apps/remote/.data/workspaces/6ab34c26-365d-44bd-8760-c5ddf587b878/script.js)
- 大聪明 max：[index.html](/Users/bones/develop/Models-Kindergarten/apps/remote/.data/workspaces/c06baa29-ee3e-4064-823c-843b3b114cab/index.html)、[styles.css](/Users/bones/develop/Models-Kindergarten/apps/remote/.data/workspaces/c06baa29-ee3e-4064-823c-843b3b114cab/styles.css)、[script.js](/Users/bones/develop/Models-Kindergarten/apps/remote/.data/workspaces/c06baa29-ee3e-4064-823c-843b3b114cab/script.js)

## 5. V1 架构验证

- generation 1 只有安装 Tool，没有 Skill catalog；安装成功后的 generation 2 每一轮恰好有一个 `skill_catalog`，旧目录没有被追加保留。
- 动态 `skill_catalog` 只含 `name/description/trust` JSON，不含固定协议、具体 `activate_skill({...})` 示例或待调用清单。
- Tool Schema 与目录来自同一次 resolver 解析；generation 2 的 `activate_skill.name.enum` 包含当前 Agent 的实际 11 个安装 Skill 与内置 Skill。
- `ensure_agent_skills` 返回安装事实、`installed_skill_names` 和 `capabilities_changed`，不再返回 `required_next_action.calls`。
- 大聪明四档的激活参数都一次符合 `{name}` Schema；千问两档仍先使用训练先验中的 `skill_name`，但都能依据结构化参数错误在下一轮改正。

## 6. 旧会话支线结论

只读分析会话 `276d8b85-e1d5-4457-89cd-f73863df043e`，Turn `fc0019bd-e730-4bde-9f27-bd45f17dc5ca`：

- 千问 8B balanced 先错传 `skillName + parameters`，完整 Schema 错误使其下一轮成功改为 `{name:"frontend-design"}`。
- 成功加载后，长 SKILL.md Tool 输出成为最近上下文；模型把原任务缩成“前端设计规划”，忘记另外来源和 HTML 产物。
- 旧 Runtime 同时保留旧 `sandbox-notes` catalog 和新 catalog，但模型仍选择了正确的 `frontend-design`。因此该旧会话的主要失败原因不是 sandbox 锚点，而是小模型在长 Skill 指令后丢失原任务与剩余步骤。
- 当时 thinking-only 被接受为 `end_turn`；当前 V1 Runtime 已把这种输出标记为 `EMPTY_ASSISTANT_RESPONSE`，不再伪装完成。

## 7. 尚未解决但本轮不改的问题

1. 千问 8B 的多 Skill 任务保持能力不足：能够纠正参数并加载一个 Skill，但加载长指令后丢失原任务，未进入 HTML 写入。
2. 大聪明 max 过度检查：产物已经满足功能验收，仍持续读写和运行命令，最终撞到 24 模型轮上限。此次不修改执行链；后续应单独研究停止策略与验证预算，而不是把轮数简单调大。
3. 大模型多次使用 `run_command` 做生成后修正，其中部分命令被沙箱拒绝；它们没有阻止 HTML 写入，但说明 Skill 对“可用工具/平台”的假设仍可能与受限 Runtime 不一致。
4. V1 代码保留显式版本选择和未知版本拒绝机制；因为已有通过项，本轮没有创建 V2。未来若试验 V2，必须新增独立常量并通过 `MK_SKILL_CONTEXT_VERSION=v1` 精确回滚。

## 8. 自动验证

- `pnpm typecheck`：通过，8 个工作区类型检查全部成功。
- `pnpm test`：通过，所有工作区测试成功；Remote 37 个测试文件、210 个测试通过。
- 64 MiB SSE 流边界测试在全仓并行时超过默认 5 秒两次；只把该测试自己的 timeout 调整为 15 秒，生产的 64 MiB 限制和取消逻辑未改变。调整后全仓并行测试通过。
- 相关文件 `git diff --check`：通过。
