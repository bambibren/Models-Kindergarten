import { opendir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PRODUCT_CONFIG } from "@kindergarten/contracts";
import type { SkillLockStore } from "./skill-lock-store.js";
import type { SkillInstallRecord, SkillRoot } from "./skill-types.js";
import { assertSkillResource, parseSkillMarkdown, validateSkillDirectory } from "./skill-validator.js";

/** Registry 只负责已安装 Skill 的索引与只读加载；不处理来源发现、下载或发布。 */
export class SkillRegistry {
  private readonly byName = new Map<string, SkillInstallRecord>();

  /** 初始化「SkillRegistry」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly roots: SkillRoot[],
    private readonly lock: SkillLockStore,
  ) {}

  /** 执行「initialize」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async initialize(): Promise<void> {
    const locked = new Map((await this.lock.load()).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => [item.name, item]));
    const next = new Map<string, SkillInstallRecord>();
    for (const root of this.roots) {
      let directory;
      try {
        directory = await opendir(root.path);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      for await (const entry of directory) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        // 容量之外的目录仍留在磁盘与安装记录中，但不再读取正文或加入 Runtime 能力。
        if (next.size >= PRODUCT_CONFIG.capacity.maxInstalledSkills) continue;
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
        if ([...next.values()].some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.name === skill.name)) {
          throw new Error(`多个作用域存在同名 Skill: ${skill.name}`);
        }
        next.set(skill.name, withoutInstructions(skill));
      }
    }
    this.byName.clear();
    for (const [name, skill] of next) this.byName.set(name, skill);
  }

  /** 执行「refresh」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async refresh(): Promise<void> {
    await this.initialize();
  }

  /** 执行「all」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
all(): SkillInstallRecord[] {
    return structuredClone([...this.byName.values()]);
  }

  /** 执行「selected」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
selected(names: string[]): SkillInstallRecord[] {
    return names.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(name) => structuredClone(this.require(name)));
  }

  /** 执行「instructions」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async instructions(
    name: string,
    allowedNames: Set<string>,
  ): Promise<{ content: string; record: SkillInstallRecord }> {
    this.assertAllowed(name, allowedNames);
    const skill = this.require(name);
    const skillFile = await assertSkillResource(skill.rootPath, "SKILL.md");
    const { instructions } = parseSkillMarkdown(await readFile(skillFile, "utf8"));
    return { content: instructions, record: structuredClone(skill) };
  }

  /** 读取「readResource」所需数据，并遵守作用域、分页与容量边界。 */
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
      record: structuredClone(skill),
    };
  }

  /** 校验并规范化「assertAllowed」输入，非法数据直接返回明确错误。 */
private assertAllowed(name: string, allowedNames: Set<string>): void {
    if (!allowedNames.has(name)) throw new Error(`当前 Agent 未绑定 Skill: ${name}`);
  }

  /** 校验并取得「require」所需对象；缺失或归属不符时立即抛出明确错误。 */
private require(name: string): SkillInstallRecord {
    const skill = this.byName.get(name);
    if (!skill) throw new Error(`Skill 不存在: ${name}`);
    return skill;
  }
}

/** 执行「defaultBase」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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

/** 执行「withoutInstructions」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function withoutInstructions(skill: import("./skill-types.js").SkillDefinition): SkillInstallRecord {
  const { instructions: _instructions, ...record } = skill;
  return structuredClone(record);
}

/** 判断「isMissing」对应条件，只返回判定结果且不修改输入状态。 */
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
