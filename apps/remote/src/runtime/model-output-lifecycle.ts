import type {
  ModelOutputItemCompleted,
  ModelOutputItemDelta,
  ModelOutputItemStarted,
  ModelToolCall,
} from "../model/model-provider.js";
import { RunFailure } from "./run-failure.js";

interface OutputItemState {
  started: ModelOutputItemStarted;
  text: string;
  toolName: string;
  toolArguments: string;
  completed?: ModelOutputItemCompleted;
}

export interface ModelOutputSnapshot {
  content: string;
  thinking: string;
  calls: ModelToolCall[];
}

/**
 * Runtime 内部的模型输出项状态机。Provider 负责翻译 wire，状态机负责拒绝非法顺序；
 * 它不认识 ACP、Session 或工具 Handler。
 */
export class ModelOutputLifecycle {
  private readonly items = new Map<string, OutputItemState>();
  private readonly callIds = new Set<string>();

  start(item: ModelOutputItemStarted): void {
    if (!item.id) throw invalid("模型输出 item id 为空");
    if (this.items.has(item.id)) throw invalid(`模型输出 item ${item.id} 重复开始`);
    if (item.kind === "tool_call") {
      if (!item.callId) throw invalid(`模型工具 item ${item.id} 缺少 callId`);
      if (this.callIds.has(item.callId)) throw invalid(`模型工具 callId ${item.callId} 重复`);
      this.callIds.add(item.callId);
    }
    this.items.set(item.id, {
      started: structuredClone(item),
      text: "",
      toolName: item.kind === "tool_call" ? item.name ?? "" : "",
      toolArguments: "",
    });
  }

  delta(itemId: string, delta: ModelOutputItemDelta): ModelOutputItemStarted["kind"] {
    const state = this.open(itemId);
    if (state.started.kind === "reasoning" || state.started.kind === "message") {
      if (delta.kind !== "text") {
        throw invalid(`文本 item ${itemId} 收到 ${delta.kind} 增量`);
      }
      state.text += delta.text;
      return state.started.kind;
    }
    if (delta.kind === "text") throw invalid(`工具 item ${itemId} 收到文本增量`);
    if (delta.kind === "tool_name") state.toolName += delta.text;
    else state.toolArguments += delta.text;
    return state.started.kind;
  }

  complete(item: ModelOutputItemCompleted): void {
    const state = this.open(item.id);
    if (state.started.kind !== item.kind) {
      throw invalid(`模型输出 item ${item.id} 从 ${state.started.kind} 变为 ${item.kind}`);
    }
    if (item.kind === "tool_call") {
      if (state.started.kind !== "tool_call") throw invalid(`模型工具 item ${item.id} 类型无效`);
      if (item.call.id !== state.started.callId) {
        throw invalid(`模型工具 item ${item.id} 的 callId 在完成时发生变化`);
      }
    }
    state.completed = structuredClone(item);
  }

  snapshot(): ModelOutputSnapshot {
    const openItems = [...this.items.entries()].filter(([, state]) => state.completed === undefined);
    if (openItems.length > 0) {
      throw invalid(`模型响应结束时仍有未完成 item: ${openItems.map(([id]) => id).join(", ")}`);
    }
    const completed = [...this.items.values()].flatMap((state) => state.completed ? [state.completed] : []);
    return {
      content: completed.flatMap((item) => item.kind === "message" ? [item.text] : []).join(""),
      thinking: completed.flatMap((item) => item.kind === "reasoning" ? [item.text] : []).join(""),
      calls: completed.flatMap((item) => item.kind === "tool_call" ? [structuredClone(item.call)] : []),
    };
  }

  private open(itemId: string): OutputItemState {
    const state = this.require(itemId);
    if (state.completed) throw invalid(`模型输出 item ${itemId} 完成后仍收到事件`);
    return state;
  }

  private require(itemId: string): OutputItemState {
    const state = this.items.get(itemId);
    if (!state) throw invalid(`模型输出 item ${itemId} 尚未开始`);
    return state;
  }
}

function invalid(message: string): RunFailure {
  return new RunFailure(message, "MODEL_INVALID_RESPONSE", false);
}
