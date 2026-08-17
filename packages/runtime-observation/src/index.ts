export type ObservationReasoningProfile = "auto" | "fast" | "balanced" | "deep" | "max";
export type ObservationConcreteReasoningProfile = Exclude<ObservationReasoningProfile, "auto">;

/** 与产品 contract 同形的自包含观察快照，避免观察包反向依赖领域包。 */
export interface RuntimeResolvedReasoningSnapshot {
  schemaVersion: 1;
  requestedProfile: ObservationReasoningProfile;
  resolvedProfile: ObservationConcreteReasoningProfile;
  source: "session_override" | "model_default";
  providerKind: string;
  model: string;
  native: Record<string, string | number | boolean>;
}

export interface RuntimeVariantSnapshot {
  studentId: string;
  studentName: string;
  provider: string;
  model: string;
  temperature?: number;
  systemPromptHash: string;
  runtimeVersion: string;
  toolNames: string[];
  capabilities?: {
    tools: Array<{
      id: string;
      modelName: string;
      origin: "builtin" | "mcp" | "skill_runtime";
      schemaHash: string;
      serverId?: string;
      remoteName?: string;
    }>;
    mcpServers: Array<{
      serverId: string;
      protocolEra: "modern" | "legacy";
      revision: string;
      toolSchemaHashes: Record<string, string>;
    }>;
    skills: Array<{
      name: string;
      contentHash: string;
      source: "builtin" | "project" | "user" | "git" | "resource";
    }>;
  };
}

export type ContextMessageSource =
  | "system"
  | "session_history"
  | "current_turn"
  | "tool_result"
  | "memory"
  | "retrieval"
  | "summary"
  | "skill_catalog"
  | "mcp_resource_catalog"
  | "mcp_resource";

export interface ContextMessageObservation {
  role: "system" | "user" | "assistant" | "tool";
  source: ContextMessageSource;
  sourceId?: string;
  content: string;
  estimatedTokens: number;
}

export type RuntimeObservationEvent =
  | {
      type: "capability_generation_changed";
      runId: string;
      generation: number;
      hash: string;
      at: number;
    }
  | {
      type: "turn_started";
      runId: string;
      sessionId: string;
      turnId: string;
      startedAt: number;
      variant: RuntimeVariantSnapshot;
      resolvedReasoning: RuntimeResolvedReasoningSnapshot;
    }
  | {
      type: "model_round_started";
      runId: string;
      roundId: string;
      index: number;
      startedAt: number;
      resolvedReasoning: RuntimeResolvedReasoningSnapshot;
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
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
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
