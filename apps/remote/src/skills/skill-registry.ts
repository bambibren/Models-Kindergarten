import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { SkillLockStore } from "./skill-lock-store.js";
import type { SkillDefinition, SkillInstallRecord, SkillRoot } from "./skill-types.js";
import { assertSkillResource, validateSkillDirectory } from "./skill-validator.js";

/** Registry 只负责发现和只读加载；安装与 Git 网络操作由 SkillInstaller 单独承担。 */
export class SkillRegistry {
  private readonly byId = new Map<string, SkillDefinition>();

  constructor(
    private readonly roots: SkillRoot[],
    private readonly lock: SkillLockStore,
  ) {}

  async initialize(): Promise<void> {
    const locked = new Map((await this.lock.load()).map((item) => [item.name, item]));
    const next = new Map<string, SkillDefinition>();
    for (const root of this.roots) {
      let entries;
      try {
        entries = await readdir(root.path, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const path = resolve(root.path, entry.name);
        const lockRecord = locked.get(entry.name);
        const base = lockRecord
          ? {
              source: lockRecord.source,
              scope: lockRecord.scope,
              installedAt: lockRecord.installedAt,
              trust: lockRecord.trust,
            }
          : defaultBase(root, path);
        const skill = await validateSkillDirectory(path, base);
        if (lockRecord && lockRecord.contentHash !== skill.contentHash) {
          throw new Error(`Skill ${entry.name} 内容与 lock 不一致`);
        }
        if ([...next.values()].some((item) => item.name === skill.name)) {
          throw new Error(`多个作用域存在同名 Skill: ${skill.name}`);
        }
        next.set(skill.id, skill);
      }
    }
    this.byId.clear();
    for (const [id, skill] of next) this.byId.set(id, skill);
  }

  all(): SkillInstallRecord[] {
    return [...this.byId.values()].map(withoutInstructions);
  }

  selected(ids: string[]): SkillInstallRecord[] {
    return ids.map((id) => withoutInstructions(this.require(id)));
  }

  instructions(id: string, allowedIds: Set<string>): { content: string; record: SkillInstallRecord } {
    this.assertAllowed(id, allowedIds);
    const skill = this.require(id);
    return { content: skill.instructions, record: withoutInstructions(skill) };
  }

  async readResource(
    id: string,
    relativePath: string,
    allowedIds: Set<string>,
  ): Promise<{ content: string; path: string; record: SkillInstallRecord }> {
    this.assertAllowed(id, allowedIds);
    if (relativePath === "SKILL.md") throw new Error("请使用 activate_skill 读取 SKILL.md");
    const skill = this.require(id);
    const path = await assertSkillResource(skill.rootPath, relativePath);
    return {
      content: await readFile(path, "utf8"),
      path: relativePath,
      record: withoutInstructions(skill),
    };
  }

  private assertAllowed(id: string, allowedIds: Set<string>): void {
    if (!allowedIds.has(id)) throw new Error(`当前 AgentVersion 未绑定 Skill: ${id}`);
  }

  private require(id: string): SkillDefinition {
    const skill = this.byId.get(id);
    if (!skill) throw new Error(`Skill 不存在: ${id}`);
    return skill;
  }
}

function defaultBase(root: SkillRoot, path: string) {
  const source = root.source === "builtin"
    ? { kind: "builtin" as const, version: "workspace" }
    : root.source === "project"
      ? { kind: "project" as const, path }
      : { kind: "user" as const, path };
  return {
    source,
    scope: root.scope,
    installedAt: 0,
    trust: root.trust,
  };
}

function withoutInstructions(skill: SkillDefinition): SkillInstallRecord {
  const { instructions: _instructions, ...record } = skill;
  return structuredClone(record);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
