export type SkillScope = "builtin" | "project" | "user";
export type SkillSourceKind = "builtin" | "project" | "user" | "git";

export interface SkillManifest {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  metadata?: Record<string, string>;
}

export interface SkillInstallRecord {
  id: string;
  name: string;
  description: string;
  source:
    | { kind: "builtin"; version: string }
    | { kind: "project"; path: string }
    | { kind: "user"; path: string }
    | { kind: "git"; url: string; commit: string; subdir?: string };
  scope: SkillScope;
  rootPath: string;
  contentHash: string;
  installedAt: number;
  trust: "builtin" | "approved" | "untrusted";
  manifest: SkillManifest;
}

export interface SkillDefinition extends SkillInstallRecord {
  instructions: string;
}

export interface SkillRoot {
  path: string;
  scope: SkillScope;
  trust: SkillInstallRecord["trust"];
  source: SkillSourceKind;
}

export type SkillInstallSource =
  | { kind: "local"; path: string }
  | { kind: "git"; url: string; ref: string; subdir?: string };

export interface SkillInstallRequest {
  source: SkillInstallSource;
  approved: boolean;
}
