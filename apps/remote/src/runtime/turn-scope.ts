import type { SessionRecord } from "../repository/session-types.js";
import type { ConcreteReasoningProfile } from "@kindergarten/contracts";

export interface TurnScope {
  schemaVersion: 1;
  ownerId: string;
  sessionId: string;
  turnId: string;
  purpose: "chat" | "experiment";
  modelStudentId: string;
  agentId: string;
  reasoningOverride?: ConcreteReasoningProfile;
  experimentRunRef?: { experimentId: string; variantId: string };
}

export function turnScope(session: SessionRecord, turnId: string): TurnScope {
  return {
    schemaVersion: 1,
    ownerId: session.ownerId,
    sessionId: session.id,
    turnId,
    purpose: session.purpose,
    modelStudentId: session.modelStudentId,
    agentId: session.agentId,
    ...(session.reasoningOverride ? { reasoningOverride: session.reasoningOverride } : {}),
    ...(session.experimentRef ? { experimentRunRef: structuredClone(session.experimentRef) } : {}),
  };
}
