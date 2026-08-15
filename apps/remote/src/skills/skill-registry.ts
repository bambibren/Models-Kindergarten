import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { SkillLockStore } from "./skill-lock-store.js";
import type { SkillDefinition, SkillInstallRecord, SkillRoot } from "./skill-types.js";
import { assertSkillResource, validateSkillDirectory } from "./skill-validator.js";

/** Registry 只负责已安装 Skill 的索引与只读加载；不处理来源发现、下载或发布。 */
export class SkillRegistry {
  private readonly byName = new Map<string, SkillDefinition>();

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
        next.set(skill.name, skill);
      }
    }
    this.byName.clear();
    for (const [name, skill] of next) this.byName.set(name, skill);
  }

  async refresh(): Promise<void> {
    await this.initialize();
  }

  all(): SkillInstallRecord[] {
    return [...this.byName.values()].map(withoutInstructions);
  }

  selected(names: string[]): SkillInstallRecord[] {
    return names.map((name) => withoutInstructions(this.require(name)));
  }

  instructions(name: string, allowedNames: Set<string>): { content: string; record: SkillInstallRecord } {
    this.assertAllowed(name, allowedNames);
    const skill = this.require(name);
    return { content: skill.instructions, record: withoutInstructions(skill) };
  }

  async readResource(
    name: string,
    relativePath: string,
    allowedNames: Set<string>,
  ): Promise<{ content: string; path: string; record: SkillInstallRecord }> {
    this.assertAllowed(name, allowedNames);
    if (relativePath === "SKILL.md") throw new Error("请使用 activate_skill 读取 SKILL.md");
    const skill = this.require(name);
    const path = await assertSkillResource(skill.rootPath, relativePath);
    return {
      content: await readFile(path, "utf8"),
      path: relativePath,
      record: withoutInstructions(skill),
    };
  }

  private assertAllowed(name: string, allowedNames: Set<string>): void {
    if (!allowedNames.has(name)) throw new Error(`当前 Agent 未绑定 Skill: ${name}`);
  }

  private require(name: string): SkillDefinition {
    const skill = this.byName.get(name);
    if (!skill) throw new Error(`Skill 不存在: ${name}`);
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
