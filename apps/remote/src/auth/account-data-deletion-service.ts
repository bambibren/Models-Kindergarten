import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { WritableSecretStore } from "../mcp/secret-store.js";
import type { SecretRef } from "../mcp/mcp-types.js";
import { McpConfigStore } from "../mcp/mcp-config-store.js";
import { SessionRepository } from "../repository/session-repository.js";

interface JsonDocument { schemaVersion: number; records: unknown[] }
interface PartitionIndex { schemaVersion: 1; recordSchemaVersion: number; ids: string[] }

const ATOMIC_OWNER_FILES = [
  "model-student-tests.json", "model-admission-catalog.json", "agents.json",
  "skill-installations.json", "skill-install-jobs.json", "mcp-tests.json",
  "mcp-installations.json", "session-launches.json",
];

/** 仅供停机状态下的 SSH 管理脚本使用，删除账号对应的全部业务数据。 */
export class AccountDataDeletionService {
  constructor(
    private readonly dataDir: string,
    private readonly secrets?: WritableSecretStore,
  ) {}

  async deleteOwner(ownerId: string): Promise<{ sessions: number; records: number }> {
    const catalog = await readAtomic(join(this.dataDir, "model-admission-catalog.json"));
    const refs = catalog?.records.flatMap((value) => credentialRefs(value, ownerId)) ?? [];
    for (const ref of refs) await this.secrets?.delete(ref);

    const mcpInstallations = await readAtomic(join(this.dataDir, "mcp-installations.json"));
    const mcpIds = new Set(mcpInstallations?.records.flatMap((value) =>
      record(value) && value.ownerId === ownerId && typeof value.mcpInstallationId === "string"
        ? [value.mcpInstallationId]
        : []) ?? []);
    await this.removeMcpRuntimeConfig(mcpIds);

    let records = 0;
    for (const name of ATOMIC_OWNER_FILES) records += await removeAtomicOwner(join(this.dataDir, name), ownerId);

    const removedExperiments = await removePartitionOwner(join(this.dataDir, "experiments.json"), ownerId);
    records += removedExperiments.ids.length;
    await removePartitionIds(join(this.dataDir, "experiment-scorecards.json"), new Set(removedExperiments.ids));

    const removedFiles = await removePartitionOwner(join(this.dataDir, "file-references.json"), ownerId);
    records += removedFiles.ids.length;
    for (const id of removedFiles.ids) await rm(join(this.dataDir, "file-blobs", id), { force: true });

    const removedArtifacts = await removePartitionOwner(join(this.dataDir, "artifacts.json"), ownerId);
    records += removedArtifacts.ids.length;
    await pruneArtifactBlobs(this.dataDir);

    const removedScores = await removePartitionOwner(join(this.dataDir, "evaluation/score-results.json"), ownerId);
    records += removedScores.ids.length;

    const sessionsRepository = new SessionRepository(this.dataDir);
    const sessionIds = await sessionsRepository.removeOwner(ownerId);
    for (const id of sessionIds) await rm(join(this.dataDir, "workspaces", id), { recursive: true, force: true });
    await removeEvaluations(this.dataDir, new Set(sessionIds));
    return { sessions: sessionIds.length, records };
  }

  /** 停机删除账号时同步移除 Manager 的运行配置，避免安装记录消失后仍在重启时连接。 */
  private async removeMcpRuntimeConfig(ids: Set<string>): Promise<void> {
    if (ids.size === 0) return;
    const store = new McpConfigStore(join(this.dataDir, "mcp/config.json"));
    const config = await store.load();
    const removedServers = config.servers.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(server) => ids.has(server.id));
    if (removedServers.length === 0) return;
    const servers = config.servers.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(server) => !ids.has(server.id));
    const retainedAuthIds = new Set(servers.flatMap(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(server) => server.transport.kind === "streamable_http" && server.transport.authProfileId
      ? [server.transport.authProfileId]
      : []));
    const removedAuthIds = new Set(removedServers.flatMap(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(server) => server.transport.kind === "streamable_http" && server.transport.authProfileId && !retainedAuthIds.has(server.transport.authProfileId)
      ? [server.transport.authProfileId]
      : []));
    for (const profile of config.authProfiles) {
      if (removedAuthIds.has(profile.id) && profile.tokenRef) await this.secrets?.delete(profile.tokenRef);
    }
    await store.save({
      ...config,
      servers,
      authProfiles: config.authProfiles.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(profile) => !removedAuthIds.has(profile.id)),
      agentCapabilities: {
        ...config.agentCapabilities,
        mcpTools: config.agentCapabilities.mcpTools.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(tool) => ![...ids].some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(id) => tool.id.startsWith(`mcp:${id}:tool:`))),
        resources: config.agentCapabilities.resources.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(resource) => !ids.has(resource.serverId)),
      },
    });
  }
}

function credentialRefs(value: unknown, ownerId: string): SecretRef[] {
  if (!record(value) || value.ownerId !== ownerId || value.recordKind !== "provider_connection") return [];
  const ref = value.credentialRef;
  return record(ref) && (ref.provider === "managed" || ref.provider === "keychain") && typeof ref.key === "string"
    ? [{ provider: "managed", key: ref.key }] : [];
}

async function removeAtomicOwner(file: string, ownerId: string): Promise<number> {
  const document = await readAtomic(file);
  if (!document) return 0;
  const kept = document.records.filter((value) => !record(value) || value.ownerId !== ownerId);
  const removed = document.records.length - kept.length;
  if (removed > 0) await writePrimaryAndBackup(file, { ...document, records: kept });
  return removed;
}

async function readAtomic(file: string): Promise<JsonDocument | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!record(value) || typeof value.schemaVersion !== "number" || !Array.isArray(value.records)) {
      throw new Error(`账号数据清理遇到无效 Store: ${file}`);
    }
    return value as unknown as JsonDocument;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

async function removePartitionOwner(legacyFile: string, ownerId: string): Promise<{ ids: string[] }> {
  const legacy = await readAtomic(legacyFile);
  const legacyRemoved = legacy?.records.filter((value) => record(value) && value.ownerId === ownerId) ?? [];
  if (legacy && legacyRemoved.length > 0) {
    await writePrimaryAndBackup(legacyFile, {
      ...legacy,
      records: legacy.records.filter((value) => !record(value) || value.ownerId !== ownerId),
    });
  }
  const ids = legacyRemoved.flatMap((value) => {
    const id = partitionIdentity(legacyFile, value);
    return id ? [id] : [];
  });
  const root = partitionRoot(legacyFile);
  const index = await readPartitionIndex(root);
  if (!index) return { ids };
  const removed = [...ids];
  for (const id of index.ids) {
    const value = await readPartitionValue(root, id);
    if (record(value) && value.ownerId === ownerId) removed.push(id);
  }
  await removePartitionIds(legacyFile, new Set(removed));
  return { ids: removed };
}

async function removePartitionIds(legacyFile: string, removed: Set<string>): Promise<void> {
  if (removed.size === 0) return;
  const legacy = await readAtomic(legacyFile);
  if (legacy) {
    const kept = legacy.records.filter((value) => {
      const id = partitionIdentity(legacyFile, value);
      return !id || !removed.has(id);
    });
    if (kept.length !== legacy.records.length) await writePrimaryAndBackup(legacyFile, { ...legacy, records: kept });
  }
  const root = partitionRoot(legacyFile);
  const index = await readPartitionIndex(root);
  if (!index) return;
  await writePrimaryAndBackup(join(root, "index.json"), { ...index, ids: index.ids.filter((id) => !removed.has(id)) });
  for (const id of removed) {
    const file = partitionRecordFile(root, id);
    await rm(file, { force: true });
    await rm(`${file}.bak`, { force: true });
  }
}

async function readPartitionIndex(root: string): Promise<PartitionIndex | undefined> {
  try {
    const value = JSON.parse(await readFile(join(root, "index.json"), "utf8")) as PartitionIndex;
    if (value.schemaVersion !== 1 || !Array.isArray(value.ids)) throw new Error(`分片索引无效: ${root}`);
    return value;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

async function readPartitionValue(root: string, id: string): Promise<unknown> {
  const value = JSON.parse(await readFile(partitionRecordFile(root, id), "utf8")) as { value?: unknown };
  return value.value;
}

function partitionRoot(file: string): string {
  return join(dirname(file), basename(file, extname(file)));
}

function partitionRecordFile(root: string, id: string): string {
  return join(root, "records", `${createHash("sha256").update(id).digest("hex")}.json`);
}

async function pruneArtifactBlobs(dataDir: string): Promise<void> {
  const legacyFile = join(dataDir, "artifacts.json");
  const root = partitionRoot(legacyFile);
  const index = await readPartitionIndex(root);
  const referenced = new Set<string>();
  if (index) for (const id of index.ids) collectHashes(await readPartitionValue(root, id), referenced);
  else for (const value of (await readAtomic(legacyFile))?.records ?? []) collectHashes(value, referenced);
  const blobDir = join(dataDir, "artifact-blobs");
  for (const entry of await readdir(blobDir, { withFileTypes: true }).catch((error) => missing(error) ? [] : Promise.reject(error))) {
    if (entry.isFile() && /^[a-f0-9]{64}$/u.test(entry.name) && !referenced.has(entry.name)) await unlink(join(blobDir, entry.name));
  }
}

function partitionIdentity(file: string, value: unknown): string | undefined {
  if (!record(value)) return undefined;
  const stem = basename(file, extname(file));
  const key = stem === "artifacts" ? "artifactId"
    : stem === "file-references" ? "fileReferenceId"
      : stem === "score-results" ? "scoreResultId"
      : "experimentId";
  return typeof value[key] === "string" ? value[key] : undefined;
}

function collectHashes(value: unknown, target: Set<string>): void {
  if (Array.isArray(value)) { for (const item of value) collectHashes(item, target); return; }
  if (!record(value)) return;
  if (typeof value.sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.sha256)) target.add(value.sha256);
  for (const nested of Object.values(value)) collectHashes(nested, target);
}

async function removeEvaluations(dataDir: string, sessions: Set<string>): Promise<void> {
  if (sessions.size === 0) return;
  const root = join(dataDir, "evaluation");
  const file = join(root, "turn-evaluations.index.json");
  try {
    const index = JSON.parse(await readFile(file, "utf8")) as { version: number; records: Array<{ sessionId: string; file: string }> };
    const removed = index.records.filter((item) => sessions.has(item.sessionId));
    await writeJson(file, { ...index, records: index.records.filter((item) => !sessions.has(item.sessionId)) });
    for (const item of removed) await rm(join(root, "turn-evaluations", item.file), { force: true });
  } catch (error) {
    if (!missing(error)) throw error;
  }
  await removeEffectScores(join(root, "turn-effect-scores"), sessions);
}

/** 人工效果分没有独立账号索引，停机删号时逐个核对记录内的 Session 身份。 */
async function removeEffectScores(dir: string, sessions: Set<string>): Promise<void> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  for (const file of files) {
    if (extname(file) !== ".json") continue;
    const path = join(dir, file);
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!record(value) || typeof value.sessionId !== "string" || typeof value.turnId !== "string") {
      throw new Error(`账号数据清理遇到无效效果打分: ${path}`);
    }
    if (sessions.has(value.sessionId)) await rm(path, { force: true });
  }
}

async function writePrimaryAndBackup(file: string, value: unknown): Promise<void> {
  await writeJson(file, value);
  await copyFile(file, `${file}.bak`);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function missing(error: unknown): boolean {
  return record(error) && error.code === "ENOENT";
}
