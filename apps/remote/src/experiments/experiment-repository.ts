import type { AnyExperimentRecord, ExperimentScorecard } from "@kindergarten/contracts";
import { AtomicJsonStore } from "../storage/atomic-json-store.js";

export class ExperimentRepository {
  private readonly experiments: AtomicJsonStore<AnyExperimentRecord>;
  private readonly scorecards: AtomicJsonStore<ExperimentScorecard>;

  constructor(experimentsFile: string, scorecardsFile: string) {
    this.experiments = new AtomicJsonStore({
      file: experimentsFile,
      schemaVersion: 2,
      legacySchemaVersions: [1],
      validate: isExperiment,
    });
    this.scorecards = new AtomicJsonStore({ file: scorecardsFile, schemaVersion: 1, validate: isScorecard });
  }

  list(): Promise<AnyExperimentRecord[]> { return this.experiments.read(); }
  async get(id: string): Promise<AnyExperimentRecord | undefined> { return (await this.experiments.read()).find((item) => item.experimentId === id); }
  async put(value: AnyExperimentRecord): Promise<void> {
    await this.experiments.update((records) => [...records.filter((item) => item.experimentId !== value.experimentId), value]);
  }
  async update(id: string, change: (value: AnyExperimentRecord) => AnyExperimentRecord): Promise<AnyExperimentRecord> {
    const result = await this.experiments.update((records) => {
      const index = records.findIndex((item) => item.experimentId === id);
      if (index < 0) throw new Error(`Experiment 不存在: ${id}`);
      const next = [...records];
      const value = change(structuredClone(next[index]!));
      next[index] = value;
      return { records: next, result: value };
    });
    if (!result) throw new Error(`Experiment 不存在: ${id}`);
    return result;
  }
  async getScorecard(experimentId: string): Promise<ExperimentScorecard | undefined> {
    return (await this.scorecards.read()).find((item) => item.experimentId === experimentId);
  }
  async putScorecard(value: ExperimentScorecard): Promise<void> {
    await this.scorecards.update((records) => [...records.filter((item) => item.experimentId !== value.experimentId), value]);
  }
  async deleteScorecard(experimentId: string): Promise<void> {
    await this.scorecards.update((records) => records.filter((item) => item.experimentId !== experimentId));
  }
  async remove(experimentId: string): Promise<void> {
    await this.experiments.update((records) => records.filter((item) => item.experimentId !== experimentId));
    await this.deleteScorecard(experimentId);
  }
}

function isExperiment(value: unknown): value is AnyExperimentRecord {
  if (!record(value)) return false;
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) return false;
  const configs = value.schemaVersion === 1 ? value.variants : value.tests;
  return typeof value.experimentId === "string" && typeof value.ownerId === "string" &&
    typeof value.status === "string" && Array.isArray(configs) && Array.isArray(value.runs) &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string";
}
function isScorecard(value: unknown): value is ExperimentScorecard {
  return record(value) && value.schemaVersion === 1 && typeof value.scorecardId === "string" &&
    typeof value.experimentId === "string" && typeof value.status === "string" && Array.isArray(value.variants);
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
