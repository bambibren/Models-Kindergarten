import { cp, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { basename, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { GitRepository } from "../git/git-repository.js";
import type { SkillLockStore } from "./skill-lock-store.js";
import type { SkillInstallRecord, SkillInstallRequest } from "./skill-types.js";
import { validateSkillDirectory } from "./skill-validator.js";

/** 安装器在隔离目录完成校验后再原子发布；不会执行 Skill 自带脚本。 */
export class SkillInstaller {
  constructor(
    private readonly installRoot: string,
    private readonly lock: SkillLockStore,
  ) {}

  async install(
    request: SkillInstallRequest,
    options: { replaceExisting?: boolean } = {},
  ): Promise<SkillInstallRecord> {
    if (!request.approved) throw new Error("安装 Skill 必须显式确认 approved=true");
    await mkdir(this.installRoot, { recursive: true });
    const quarantine = await mkdtemp(resolve(this.installRoot, ".install-"));
    try {
      const staged = request.source.kind === "local"
        ? await this.stageLocal(request.source.path, quarantine)
        : await this.stageGit(request.source, quarantine);
      const provisional = await validateSkillDirectory(staged.path, {
        source: staged.source,
        scope: "user",
        installedAt: Date.now(),
        trust: "approved",
      });
      const target = resolve(this.installRoot, provisional.name);
      const targetExists = await exists(target);
      if (targetExists && !options.replaceExisting) throw new Error(`Skill 已安装: ${provisional.name}`);
      const publish = resolve(quarantine, provisional.name);
      if (staged.path !== publish) await rename(staged.path, publish);
      const previous = resolve(quarantine, `${provisional.name}.previous`);
      if (targetExists) await rename(target, previous);
      try {
        await rename(publish, target);
      } catch (error) {
        if (targetExists) await rename(previous, target);
        throw error;
      }
      const record: SkillInstallRecord = {
        ...withoutInstructions(provisional),
        rootPath: await realpath(target),
      };
      try {
        if (targetExists) await this.lock.upsert(record);
        else await this.lock.put(record);
      } catch (error) {
        await rm(target, { recursive: true, force: true });
        if (targetExists) await rename(previous, target);
        throw error;
      }
      if (targetExists) await rm(previous, { recursive: true, force: true });
      return record;
    } finally {
      await rm(quarantine, { recursive: true, force: true });
    }
  }

  async uninstall(name: string): Promise<void> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Skill name 无效");
    await rm(resolve(this.installRoot, name), { recursive: true, force: true });
    await this.lock.remove(name);
  }

  private async stageLocal(path: string, quarantine: string) {
    const source = await realpath(path);
    const target = resolve(quarantine, basename(source));
    await cp(source, target, { recursive: true, errorOnExist: true, preserveTimestamps: false });
    return {
      path: target,
      source: { kind: "user" as const, path: source },
    };
  }

  private async stageGit(
    source: Extract<SkillInstallRequest["source"], { kind: "git" }>,
    quarantine: string,
  ) {
    const url = new URL(source.url);
    if (url.protocol !== "https:") throw new Error("Git Skill 来源只允许 HTTPS");
    if (!source.ref.trim()) throw new Error("Git Skill 必须指定 ref");
    const subdirectory = skillSubdirectory(source.subdir);
    const repo = resolve(quarantine, ".checkout");
    const repository = await GitRepository.clone(source.url, repo);
    await repository.checkout(source.ref, subdirectory);
    const commit = await repository.currentCommit();
    const skillPath = resolve(repo, subdirectory);
    assertInside(repo, skillPath);
    const targetName = subdirectory !== "."
      ? basename(await realpath(skillPath))
      : basename(new URL(source.url).pathname).replace(/\.git$/i, "");
    const target = resolve(quarantine, targetName);
    await cp(skillPath, target, {
      recursive: true,
      errorOnExist: true,
      preserveTimestamps: false,
      filter: (item) => !relative(repo, item).split(sep).includes(".git"),
    });
    await rm(repo, { recursive: true, force: true });
    return {
      path: target,
      source: {
        kind: "git" as const,
        url: source.url,
        commit,
        ...(subdirectory !== "." ? { subdir: subdirectory } : {}),
      },
    };
  }
}

function assertInside(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error("Git Skill subdir 越界");
}

async function exists(path: string): Promise<boolean> {
  try {
    await realpath(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function skillSubdirectory(value: string | undefined): string {
  const subdirectory = value?.trim() || ".";
  const normalized = posix.normalize(subdirectory).replace(/^\.\//, "");
  if (subdirectory.includes("\\") || normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
    throw new Error("Git Skill subdir 越界");
  }
  return normalized;
}

function withoutInstructions<T extends { instructions: string }>(value: T): Omit<T, "instructions"> {
  const { instructions: _instructions, ...record } = value;
  return record;
}
