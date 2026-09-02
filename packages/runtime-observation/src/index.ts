/** 描述「ObservationReasoningProfile」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ObservationReasoningProfile = "auto" | "fast" | "balanced" | "deep" | "max";
/** 描述「ObservationConcreteReasoningProfile」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 描述「RuntimeVariantSnapshot」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 标记一条模型输入由 MK 的哪个上下文生产者生成。 */
export type ModelInputMessageSource =
  | "system"
  | "session_history"
  | "current_turn"
  | "tool_result"
  | "skill_catalog"
  | "mcp_resource_catalog"
  | "mcp_resource";

/** 评测与诊断使用的单条模型输入快照，不参与模型控制流。 */
export interface ModelInputMessageTrace {
  role: "system" | "user" | "assistant" | "tool";
  source: ModelInputMessageSource;
  sourceId?: string;
  /** 模型输入正文的 SHA-256；Trace 不复制真实正文。 */
  contentHash: string;
  /** 模型输入正文按 UTF-8 计算的字节数。 */
  byteLength: number;
  estimatedTokens: number;
}

/** 大正文、参数和结果在观察链中只保留不可逆摘要与容量指标。 */
export interface RuntimePayloadEvidence {
  sha256: string;
  bytes: number;
}

/** 描述「RuntimeObservationEvent」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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
        messages: ModelInputMessageTrace[];
        truncatedSourceIds: string[];
      };
    }
  | {
      type: "model_attempt_started";
      runId: string;
      roundId: string;
      attemptId: string;
      index: number;
      startedAt: number;
    }
  | {
      type: "model_attempt_failed";
      runId: string;
      roundId: string;
      attemptId: string;
      completedAt: number;
      error: { code: string; message: string; retryable: boolean };
      output: {
        text: RuntimePayloadEvidence;
        thinking?: RuntimePayloadEvidence;
      };
      retryDelayMs?: number;
    }
  | {
      type: "model_attempt_completed";
      runId: string;
      roundId: string;
      attemptId: string;
      completedAt: number;
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
        text: RuntimePayloadEvidence;
        thinking?: RuntimePayloadEvidence;
      };
    }
  | {
      type: "tool_call_started";
      runId: string;
      roundId: string;
      toolCallId: string;
      name: string;
      arguments: RuntimePayloadEvidence;
      signatureHash: string;
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
      output?: RuntimePayloadEvidence;
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
  emit: /** 执行「emit」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => undefined,
};
