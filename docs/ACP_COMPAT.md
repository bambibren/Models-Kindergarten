# ACP 协议边界

| 项目 | 值 |
| --- | --- |
| SDK | `@agentclientprotocol/sdk@1.3.0` |
| Wire protocol | ACP v1，`protocolVersion = 1` |
| Transport | SDK WebSocket transport |
| 双向交互 | `session/request_permission`、`elicitation/create` |

## 支持矩阵

| ACP method/update | V1.6 |
| --- | --- |
| initialize | 支持；Client 宣告 `elicitation.form` |
| session/new、list、load、resume、close | 支持 |
| session/prompt、cancel | 支持 |
| user/agent/thought chunk | 支持流式组装和历史回放 |
| tool_call、tool_call_update | Remote 产生，Web 聚合显示并持久化 |
| session/request_permission | `write_file` 逐次授权；`run_command` 每次授权 |
| elicitation/create | `ask_user` 表单输入 |
| terminal、Client fs、plan | 不实现 |

## 不变量

- Agent 生成 `messageId` 和 `toolCallId`；Web 只按不透明 ID 聚合；
- Tool status 可以独立完成，但只有 PromptResponse 提交整个 `streamingChatEntries`；
- Permission 是安全决策，Elicitation 是补充信息，二者不混用；
- `load` 完整回放，`resume` 零回放；
- 每次 Handler 只向当前 `AgentContext` 输出，不跨 Connection 广播。
