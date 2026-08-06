# Models Kindergarten V1.1 架构

## 主链

```text
User → React Chat → ACP Client ⇄ Remote ACP Agent → AgentRuntime Tool Loop
                                                      ├→ Ollama qwen3:8b
                                                      └→ ToolRegistry → FileSandbox
```

没有 Java/RCS 中转层、第二套事件协议或 Runtime 可视化。

## Web 聊天投影

```ts
interface ChatState {
  sessionId: string | null;
  entries: EntryCollection;
  streamingEntries: EntryCollection;
  streaming: StreamingContext | null;
}

interface EntryCollection {
  order: EntryId[];
  byId: Record<EntryId, ChatEntry>;
}
```

`order` 固定 `messageId/toolCallId` 第一次出现的位置，`byId` 允许并行 Tool 独立更新；完成顺序只改变状态，不移动卡片。`PromptResponse` 是整轮提交边界，此时一次性合并两个 Collection 并清空 `streamingEntries`。

`selectEntryBlocks(collection)` 只在渲染时把连续 Thought/Tool 派生为 `ActivityGroup`，不存储第三份聊天数据，也不是 Runtime timeline。

## Web UI

```text
AppShell
├── SessionSidebar
└── ChatScreen
    ├── ChatHeader
    ├── ChatViewport
    │   ├── ChatBlockList(entries)
    │   └── ChatBlockList(streamingEntries)
    │       ├── MessageEntryView
    │       └── ActivityGroup
    │           ├── ReasoningItem
    │           └── ToolItem
    └── ComposerDock
        ├── InteractionPendingPanel
        └── Composer
```

Zustand Store 聚合 connection、sessions、chat、prompt 和 interaction 状态；组件用窄 selector 独立订阅。Reasoning/Tool 的 disclosure 是各组件实例的局部状态：执行时展开，完成后延迟收起，用户手动选择优先。多个 streaming Tool 因此可以同时展开。

`InteractionPendingPanel` 仅展示等待处理的 ACP `session/request_permission` 或 `elicitation/create`，固定在 Composer 上方；它不进入聊天历史，ToolItem 只展示同一请求对应的执行状态。

## Tool Loop

```mermaid
sequenceDiagram
    participant Model as qwen3:8b
    participant Loop as AgentRuntime
    participant Client as ACP Web Client
    participant Tool as Sandbox Tool

    Loop->>Model: messages + tool schemas
    Model-->>Loop: text/thinking/tool_calls
    Loop-->>Client: tool_call(pending)
    alt write_file
      Loop->>Client: session/request_permission
      Client-->>Loop: allow/reject
    else ask_user
      Loop->>Client: elicitation/create(form)
      Client-->>Loop: accept(answer)/cancel
    end
    Loop->>Tool: execute validated input
    Tool-->>Loop: result/diff/error
    Loop-->>Client: tool_call_update
    Loop->>Model: assistant tool_calls + tool results
```

同一模型响应里的 Tool 先按返回顺序全部创建，再使用 `Promise.all` 并行执行。Web 可同时拥有多个未完成 Tool；权限和 AskUser 在 Client 侧排队展示。模型不再请求 Tool 时结束循环，硬上限为 8 轮。

## 安全边界

- `FileSandbox` 是唯一文件入口；
- 相对路径解析后必须仍位于固定 root；
- 每个已存在路径组件都拒绝符号链接并校验 `realpath`；
- `write_file` 必须获得 ACP permission；
- AskUser 使用 Elicitation，不与安全授权混用；
- 没有 Shell、网络或任意代码执行能力；
- Prompt Cancel 传播到模型、等待中的交互和 Tool。

## 稳定历史

Repository V2 保存有序 `StoredEntry[]`：

- Message：role、messageId、turnId、完整文本；
- Thought：messageId、turnId、完整文本；
- ToolCall：toolCallId、kind、状态、输入、输出、content、locations。

运行时使用稳定 user/assistant Message 重建模型上下文；Tool/Thought 用于 UI 完整回放。旧版 `messages[]` 会在读取时迁移。

## ModelStudent

ModelStudent 继续合并模型身份、Provider 绑定和当前 Agent 配置。默认 Provider 为 Ollama、模型为 `qwen3:8b`。只有出现配置编辑后的会话复现和版本对比需求时，才提取不可变 AgentVersion。
