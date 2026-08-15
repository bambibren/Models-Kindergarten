export interface LocalPrincipal {
  schemaVersion: 1;
  principalId: "local-admin";
  kind: "local_admin";
}

export interface ModelStudentSummary {
  schemaVersion: 1;
  modelStudentId: string;
  displayName: string;
  sizeClass: "small" | "large";
  providerKind: string;
  model: string;
  status: "ready" | "unavailable" | "unknown";
  supports: {
    streaming: boolean;
    toolCalls: boolean;
    thought: boolean;
    usage: boolean;
    reasoning: import("./reasoning.js").ModelReasoningCapability;
  };
  lastCheckedAt?: string;
  statusMessage?: string;
  deletable?: boolean;
}

export interface OperationProjectionMeta {
  schemaVersion: 1;
  kind: "skill_install";
  operationId: string;
  state: import("./skill-management.js").OperationState;
  itemStates?: Array<{ itemId: string; label: string; state: string }>;
}

export interface FileReferencesMeta {
  schemaVersion: 1;
  fileReferenceIds: string[];
}
