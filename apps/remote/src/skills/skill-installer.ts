import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { SkillLockStore } from "./skill-lock-store.js";
import type { SkillInstallRecord, SkillInstallRequest } from "./skill-types.js";
import { validateSkillDirectory } from "./skill-validator.js";

const execFileAsync = promisify(execFile);

/** 安装器在隔离目录完成校验后再原子发布；不会执行 Skill 自带脚本。 */
export class SkillInstaller {
  constructor(
    private readonly installRoot: string,
    private readonly lock: SkillLockStore,
  ) {}

  async install(request: SkillInstallRequest): Promise<SkillInstallRecord> {
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
      if (await exists(target)) throw new Error(`Skill 已安装: ${provisional.name}`);
      const publish = resolve(quarantine, provisional.name);
      if (staged.path !== publish) await rename(staged.path, publish);
      await rename(publish, target);
      const record: SkillInstallRecord = {
        ...withoutInstructions(provisional),
        rootPath: await realpath(target),
      };
      try {
        await this.lock.put(record);
      } catch (error) {
        await rm(target, { recursive: true, force: true });
        throw error;
      }
      return record;
    } finally {
      await rm(quarantine, { recursive: true, force: true });
    }
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
    const repo = resolve(quarantine, "repo");
    await execFileAsync("git", ["clone", "--filter=blob:none", "--no-checkout", source.url, repo], {
      maxBuffer: 1024 * 1024,
    });
    await execFileAsync("git", ["-C", repo, "checkout", "--detach", source.ref], { maxBuffer: 1024 * 1024 });
    const { stdout } = await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" });
    const commit = stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error("无法固定 Git Skill Commit");
    const skillPath = resolve(repo, source.subdir ?? ".");
    assertInside(repo, skillPath);
    const target = resolve(quarantine, basename(await realpath(skillPath)));
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
        ...(source.subdir ? { subdir: source.subdir } : {}),
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

function withoutInstructions<T extends { instructions: string }>(value: T): Omit<T, "instructions"> {
  const { instructions: _instructions, ...record } = value;
  return record;
}
