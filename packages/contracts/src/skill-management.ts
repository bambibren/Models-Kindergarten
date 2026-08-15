import type { PublicErrorRef } from "./common.js";

export type SkillInstallationState = "queued" | "validating" | "installing" | "ready" | "quarantined" | "failed" | "uninstalled";
export type OperationState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export type SkillSource =
  | {
      kind: "github_tree";
      repository: string;
      requestedRef: string;
      resolvedCommit?: string;
      subdirectory: string;
    }
  | { kind: "approved_local"; sourceId: string };

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

export interface SkillInstallJobItem {
  itemId: string;
  source: SkillSource;
  state: SkillInstallationState;
  skillInstallationId?: string;
  disposition?: "installed" | "reused" | "updated";
  error?: PublicErrorRef;
}

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

export interface EnsureAgentSkillsInput {
  sourceUrls: string[];
  mode: "ensure" | "update";
}
