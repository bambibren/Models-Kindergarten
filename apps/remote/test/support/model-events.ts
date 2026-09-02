import type { ModelEvent, ModelToolCall } from "../../src/model/model-provider.js";

let sequence = 0;

/** 测试 Provider 用的完整文本 item；每次调用生成独立身份。 */
export function messageEvents(text: string): ModelEvent[] {
  return textEvents("message", text);
}

/** 测试 Provider 用的完整 reasoning item；每次调用生成独立身份。 */
export function reasoningEvents(text: string): ModelEvent[] {
  return textEvents("reasoning", text);
}

/** 测试 Provider 用的完整工具 item；正式 Adapter 不依赖此辅助函数。 */
export function toolCallEvents(calls: ModelToolCall[]): ModelEvent[] {
  return calls.flatMap((rawCall, index) => {
    const itemId = `test:item:${sequence++}:tool:${index}`;
    const call = { ...rawCall, id: rawCall.id ?? `${itemId}:call` };
    return [
      { type: "output_item_started", item: { id: itemId, kind: "tool_call", callId: call.id, name: call.name } },
      { type: "output_item_completed", item: { id: itemId, kind: "tool_call", call } },
    ];
  });
}

function textEvents(kind: "message" | "reasoning", text: string): ModelEvent[] {
  const itemId = `test:item:${sequence++}:${kind}`;
  return [
    { type: "output_item_started", item: { id: itemId, kind } },
    { type: "output_item_delta", itemId, delta: { kind: "text", text } },
    { type: "output_item_completed", item: { id: itemId, kind, text } },
  ];
}
