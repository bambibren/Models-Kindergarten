export interface RuntimeVariantSnapshot {
  studentId: string;
  studentName: string;
  provider: string;
  model: string;
  temperature?: number;
  systemPromptHash: string;
  runtimeVersion: string;
  toolNames: string[];
}

export type ContextMessageSource =
  | "system"
  | "session_history"
  | "current_turn"
  | "tool_result"
  | "memory"
  | "retrieval"
  | "summary";

export interface ContextMessageObservation {
  role: "system" | "user" | "assistant" | "tool";
  source: ContextMessageSource;
  sourceId?: string;
  content: string;
  estimatedTokens: number;
}

export type RuntimeObservationEvent =
  | {
      type: "turn_started";
      runId: string;
      sessionId: string;
      turnId: string;
      startedAt: number;
      variant: RuntimeVariantSnapshot;
    }
  | {
      type: "model_round_started";
      runId: string;
      roundId: string;
      index: number;
      startedAt: number;
      context: {
        messages: ContextMessageObservation[];
        truncatedSourceIds: string[];
      };
    }
  | {
      type: "model_round_first_token";
      runId: string;
      roundId: string;
      at: number;
    }
  | {
      type: "model_round_usage";
      runId: string;
      roundId: string;
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      type: "model_round_completed";
      runId: string;
      roundId: string;
      completedAt: number;
      stopReason: "stop" | "length" | "cancelled";
      output: {
        text: string;
        thinking?: string;
      };
    }
  | {
      type: "tool_call_started";
      runId: string;
      roundId: string;
      toolCallId: string;
      name: string;
      arguments: unknown;
      signature: string;
      permission: "allow" | "ask" | "always_ask" | "deny";
      startedAt: number;
    }
  | {
      type: "permission_decided";
      runId: string;
      toolCallId: string;
      required: boolean;
      decision: "allowed" | "denied";
      decidedAt: number;
    }
  | {
      type: "tool_call_completed";
      runId: string;
      toolCallId: string;
      status: "success" | "error" | "denied" | "duplicate_blocked";
      completedAt: number;
      error?: { category: string; message: string };
      output?: unknown;
    }
  | {
      type: "runtime_error";
      runId: string;
      scope: "model" | "tool_runtime" | "turn";
      message: string;
      at: number;
    }
  | {
      type: "turn_completed";
      runId: string;
      status: "completed" | "failed" | "cancelled";
      completedAt: number;
      stopReason?: string;
    };

/** Runtime 只认识这个观察端口；评测上传、持久化和 UI 都位于端口之外。 */
export interface RuntimeObservationSink {
  emit(event: RuntimeObservationEvent): void;
}

export const noopRuntimeObservationSink: RuntimeObservationSink = {
  emit: () => undefined,
};
