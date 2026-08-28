/** 描述「LocalPrincipal」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface LocalPrincipal {
  schemaVersion: 1;
  principalId: "local-admin";
  kind: "local_admin";
}

/** 描述「ModelStudentSummary」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelStudentSummary {
  schemaVersion: 1;
  modelStudentId: string;
  displayName: string;
  sizeClass: "small" | "large";
  providerKind: string;
  model: string;
  status: "ready" | "capacity_blocked" | "unavailable" | "unknown";
  supports: {
    streaming: boolean;
    toolCalls: boolean;
    thought: boolean;
    usage: boolean;
    reasoning: import("./reasoning.js").ModelReasoningCapability;
  };
  /** 用户显式配置的正整数 token 上限；未知时缺省。 */
  contextWindowTokens?: number;
  lastCheckedAt?: string;
  statusMessage?: string;
  deletable?: boolean;
}

/** 描述「OperationProjectionMeta」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface OperationProjectionMeta {
  schemaVersion: 1;
  kind: "skill_install";
  operationId: string;
  state: import("./skill-management.js").OperationState;
  itemStates?: Array<{ itemId: string; label: string; state: string }>;
}

/** 描述「FileReferencesMeta」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface FileReferencesMeta {
  schemaVersion: 1;
  fileReferenceIds: string[];
}
