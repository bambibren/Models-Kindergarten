import type { PublicErrorRef } from "./common.js";

/** 描述「SkillInstallationState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type SkillInstallationState = "queued" | "validating" | "installing" | "ready" | "capacity_blocked" | "quarantined" | "failed" | "uninstalled";
/** 描述「OperationState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type OperationState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

/** 描述「SkillSource」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type SkillSource =
  | {
      kind: "github_tree";
      repository: string;
      requestedRef: string;
      resolvedCommit?: string;
      subdirectory: string;
    }
  | {
      kind: "resource_bundle";
      url: string;
      resolvedContentHash?: string;
    }
  | { kind: "approved_local"; sourceId: string };

/** 描述「SkillInstallation」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SkillInstallation {
  schemaVersion: 1;
  skillInstallationId: string;
  ownerId: string;
  skillName: string;
  displayName?: string;
  state: SkillInstallationState;
  source: SkillSource;
  contentHash?: string;
  installedPathRef?: string;
  securitySummary?: { fileCount: number; totalBytes: number; warnings: string[] };
  error?: PublicErrorRef;
  createdAt: string;
  updatedAt: string;
  deletable?: boolean;
}

/** 描述「SkillInstallJobItem」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SkillInstallJobItem {
  itemId: string;
  source: SkillSource;
  state: SkillInstallationState;
  skillInstallationId?: string;
  disposition?: "installed" | "reused" | "updated";
  error?: PublicErrorRef;
}

/** 描述「SkillInstallJob」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SkillInstallJob {
  schemaVersion: 1;
  jobId: string;
  ownerId: string;
  origin: { kind: "manual" } | { kind: "turn"; sessionId: string; turnId: string; agentId: string };
  state: OperationState;
  items: SkillInstallJobItem[];
  bindToAgentOnComplete: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** 描述「EnsureAgentSkillsInput」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface EnsureAgentSkillsInput {
  sourceUrls: string[];
  mode: "ensure" | "update";
}
