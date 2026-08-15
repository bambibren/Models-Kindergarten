import type { SkillInstallJob, SkillInstallation } from "@kindergarten/contracts";
import { AtomicJsonStore } from "../storage/atomic-json-store.js";

export class SkillInstallationRepository {
  private readonly installations: AtomicJsonStore<SkillInstallation>;
  private readonly jobs: AtomicJsonStore<SkillInstallJob>;

  constructor(installationsFile: string, jobsFile: string) {
    this.installations = new AtomicJsonStore({
      file: installationsFile,
      schemaVersion: 1,
      validate: isInstallation,
    });
    this.jobs = new AtomicJsonStore({ file: jobsFile, schemaVersion: 1, validate: isJob });
  }

  listInstallations(): Promise<SkillInstallation[]> {
    return this.installations.read();
  }

  async getInstallation(id: string): Promise<SkillInstallation | undefined> {
    return (await this.installations.read()).find((item) => item.skillInstallationId === id);
  }

  async putInstallation(value: SkillInstallation): Promise<void> {
    await this.installations.update((records) => {
      const next = records.filter((item) => item.skillInstallationId !== value.skillInstallationId);
      next.push(value);
      return next;
    });
  }

  async removeInstallation(id: string): Promise<void> {
    await this.installations.update((records) => records.filter((item) => item.skillInstallationId !== id));
  }

  listJobs(): Promise<SkillInstallJob[]> {
    return this.jobs.read();
  }

  async getJob(id: string): Promise<SkillInstallJob | undefined> {
    return (await this.jobs.read()).find((item) => item.jobId === id);
  }

  async putJob(value: SkillInstallJob): Promise<void> {
    await this.jobs.update((records) => {
      const next = records.filter((item) => item.jobId !== value.jobId);
      next.push(value);
      return next;
    });
  }

  async interruptActiveJobs(): Promise<number> {
    return (await this.jobs.update((records) => {
      const now = new Date().toISOString();
      let count = 0;
      const next = records.map((job) => {
        if (job.state !== "queued" && job.state !== "running") return job;
        count += 1;
        return {
          ...job,
          state: "interrupted" as const,
          items: job.items.map((item) =>
            item.state === "queued" || item.state === "validating" || item.state === "installing"
              ? {
                  ...item,
                  state: "failed" as const,
                  error: {
                    code: "SKILL_JOB_INTERRUPTED" as const,
                    message: "Remote 服务重启，Skill 安装已中断，可重新提交安装",
                    retryable: true,
                  },
                }
              : item),
          updatedAt: now,
          completedAt: now,
        };
      });
      return { records: next, result: count };
    })) ?? 0;
  }
}

function isInstallation(value: unknown): value is SkillInstallation {
  if (!record(value)) return false;
  return value.schemaVersion === 1 && typeof value.skillInstallationId === "string" &&
    typeof value.ownerId === "string" && typeof value.skillName === "string" && typeof value.state === "string" && record(value.source) &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string";
}

function isJob(value: unknown): value is SkillInstallJob {
  if (!record(value)) return false;
  return value.schemaVersion === 1 && typeof value.jobId === "string" && typeof value.ownerId === "string" &&
    typeof value.state === "string" && Array.isArray(value.items) && typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
