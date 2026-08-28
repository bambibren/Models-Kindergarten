import type { SessionRecord } from "../repository/session-types.js";
import type { ConcreteReasoningProfile } from "@kindergarten/contracts";
import type { ResolvedReasoningSnapshot } from "@kindergarten/contracts";

/** 描述「TurnScope」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface TurnScope {
  schemaVersion: 1;
  ownerId: string;
  sessionId: string;
  turnId: string;
  operationId?: string;
  purpose: "chat" | "experiment";
  modelStudentId: string;
  agentId: string;
  reasoningOverride?: ConcreteReasoningProfile;
  frozenReasoning?: ResolvedReasoningSnapshot;
  experimentRunRef?: { experimentId: string; variantId: string };
}

/** 执行「turnScope」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function turnScope(session: SessionRecord, turnId: string, operationId?: string): TurnScope {
  return {
    schemaVersion: 1,
    ownerId: session.ownerId,
    sessionId: session.id,
    turnId,
    ...(operationId ? { operationId } : {}),
    purpose: session.purpose,
    modelStudentId: session.modelStudentId,
    agentId: session.agentId,
    ...(session.reasoningOverride ? { reasoningOverride: session.reasoningOverride } : {}),
    ...(session.experimentReasoning ? { frozenReasoning: structuredClone(session.experimentReasoning) } : {}),
    ...(session.experimentRef ? { experimentRunRef: structuredClone(session.experimentRef) } : {}),
  };
}
