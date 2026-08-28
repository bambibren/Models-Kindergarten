/** 描述「SkillScope」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type SkillScope = "builtin" | "project" | "user";
/** 描述「SkillSourceKind」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type SkillSourceKind = "builtin" | "project" | "user" | "git" | "resource";

/** 描述「SkillManifest」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SkillManifest {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  metadata?: Record<string, string>;
}

/** 描述「SkillInstallRecord」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SkillInstallRecord {
  name: string;
  description: string;
  source:
    | { kind: "builtin"; version: string }
    | { kind: "project"; path: string }
    | { kind: "user"; path: string }
    | { kind: "git"; url: string; commit: string; subdir?: string }
    | { kind: "resource"; url: string; contentHash: string };
  scope: SkillScope;
  rootPath: string;
  contentHash: string;
  installedAt: number;
  trust: "builtin" | "approved" | "untrusted";
  manifest: SkillManifest;
}

/** 描述「SkillDefinition」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SkillDefinition extends SkillInstallRecord {
  instructions: string;
}

/** 描述「SkillRoot」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SkillRoot {
  path: string;
  scope: SkillScope;
  trust: SkillInstallRecord["trust"];
  source: SkillSourceKind;
}

/** 描述「SkillInstallSource」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type SkillInstallSource =
  | { kind: "local"; path: string }
  | { kind: "git"; url: string; ref: string; subdir?: string }
  | { kind: "resource"; url: string };

/** 描述「SkillInstallRequest」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SkillInstallRequest {
  source: SkillInstallSource;
  approved: boolean;
}
