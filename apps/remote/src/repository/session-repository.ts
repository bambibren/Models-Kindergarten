import { copyFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import type {
  SessionEntry,
  SessionExperimentRef,
  SessionMessageEntry,
  SessionPurpose,
  SessionRecord,
  TurnExecutionRecord,
} from "./session-types.js";
import { isConcreteReasoningProfile, readTurnState, type ConcreteReasoningProfile } from "@kindergarten/contracts";
import { readProviderOpaqueContinuation } from "../model/provider-continuation.js";
import type { TurnActivePhase, TurnPendingInteraction, TurnStatus } from "@kindergarten/contracts";
import {
  addPendingTurnInteraction,
  finishTurnState,
  initialTurnState,
  interruptTurnState,
  removePendingTurnInteraction,
  transitionActiveTurn,
} from "./turn-state-machine.js";

interface SessionFileV4 { version: 4; sessions: SessionRecord[] }
interface LegacySessionBase { id: string; cwd: string; title: string; updatedAt: string }
interface SessionFileV3 { version: 3; sessions: Array<LegacySessionBase & { revision: number; sessionEntries: SessionEntry[] }> }
interface SessionFileV2 { version: 2; sessions: Array<LegacySessionBase & { entries: SessionEntry[] }> }
interface SessionFileV1 { version: 1; sessions: Array<LegacySessionBase & { messages: Array<Omit<SessionMessageEntry, "type">> }> }

export interface LegacySessionDefaults {
  ownerId: string;
  modelStudentId: string;
  agentId: string;
}

export interface CreateSessionInput {
  cwd: string;
  additionalDirectories?: string[];
  ownerId: string;
  purpose: SessionPurpose;
  modelStudentId: string;
  agentId: string;
  experimentRef?: SessionExperimentRef;
}

/** Repository V4 保存固定身份 Session 与 Turn 事实；旧文件只在显式默认值下迁移。 */
export class SessionRepository {
  private cache?: SessionRecord[];
  private writeQueue: Promise<void> = Promise.resolve();
  private migratedFrom: 1 | 2 | 3 | undefined;

  constructor(
    private readonly dir: string,
    private readonly legacyDefaults?: LegacySessionDefaults,
  ) {}

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    validateCreate(input);
    return this.enqueueWrite(async () => {
      const sessions = await this.readAll();
      const now = new Date().toISOString();
      const session: SessionRecord = {
        schemaVersion: 4,
        id: randomUUID(),
        revision: 0,
        ownerId: input.ownerId,
        purpose: input.purpose,
        cwd: input.cwd,
        additionalDirectories: [...(input.additionalDirectories ?? [])],
        title: "新对话",
        modelStudentId: input.modelStudentId,
        agentId: input.agentId,
        ...(input.experimentRef ? { experimentRef: structuredClone(input.experimentRef) } : {}),
        createdAt: now,
        updatedAt: now,
        sessionEntries: [],
        turns: [],
      };
      sessions.push(session);
      await this.save(sessions);
      return clone(session);
    });
  }

  async all(purpose?: SessionPurpose): Promise<SessionRecord[]> {
    return (await this.readAll()).filter((item) => !purpose || item.purpose === purpose).map(publicClone);
  }

  /** 仅限 Runtime/Experiment 上下文链路；不得直接返回控制面。 */
  async allForRuntime(purpose?: SessionPurpose): Promise<SessionRecord[]> {
    return (await this.readAll()).filter((item) => !purpose || item.purpose === purpose).map(clone);
  }

  async get(id: string): Promise<SessionRecord> {
    const session = (await this.readAll()).find((item) => item.id === id);
    if (!session) throw new Error(`会话不存在: ${id}`);
    return clone(session);
  }

  /** API/控制面只应读取聊天事实；Provider opaque items 只允许 Runtime 上下文链路获取。 */
  async getPublic(id: string): Promise<SessionRecord> {
    const session = (await this.readAll()).find((item) => item.id === id);
    if (!session) throw new Error(`会话不存在: ${id}`);
    return publicClone(session);
  }

  async list(cwd?: string | null, purpose: SessionPurpose = "chat"): Promise<SessionInfo[]> {
    return (await this.readAll())
      .filter((item) => item.purpose === purpose && (!cwd || item.cwd === cwd))
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((item) => ({ sessionId: item.id, cwd: item.cwd, title: item.title, updatedAt: item.updatedAt }));
  }

  async removeExperimentSessions(experimentId: string, ownerId = "local-admin"): Promise<string[]> {
    return this.enqueueWrite(async () => {
      const sessions = await this.readAll();
      const removed = sessions.filter((item) => item.ownerId === ownerId && item.purpose === "experiment" && item.experimentRef?.experimentId === experimentId);
      if (removed.length > 0) {
        const remaining = sessions.filter((item) => !removed.some((candidate) => candidate.id === item.id));
        await this.save(remaining);
        this.cache = remaining;
      }
      return removed.map((item) => item.id);
    });
  }

  async append(id: string, entry: SessionEntry): Promise<void> {
    await this.appendMany(id, [entry]);
  }

  async appendMany(id: string, entries: SessionEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.enqueueWrite(async () => {
      const sessions = await this.readAll();
      const session = requireSession(sessions, id);
      const normalizedEntries = entries.map((entry) => normalizeSessionEntry(session, entry));
      session.sessionEntries.push(...normalizedEntries);
      session.revision += 1;
      const last = normalizedEntries.at(-1);
      if (last) session.updatedAt = last.createdAt;
      const firstUser = normalizedEntries.find((entry): entry is SessionMessageEntry => entry.type === "message" && entry.role === "user");
      if (firstUser && session.title === "新对话") session.title = makeTitle(firstUser.text);
      await this.save(sessions);
    });
  }

  async setReasoningOverride(id: string, profile: ConcreteReasoningProfile | undefined): Promise<SessionRecord> {
    return this.enqueueWrite(async () => {
      const sessions = await this.readAll();
      const session = requireSession(sessions, id);
      if (profile === undefined) delete session.reasoningOverride;
      else session.reasoningOverride = profile;
      session.revision += 1;
      session.updatedAt = new Date().toISOString();
      await this.save(sessions);
      return clone(session);
    });
  }

  async startTurn(id: string, turnId: string, facts: Partial<TurnExecutionRecord> = {}): Promise<TurnExecutionRecord> {
    return this.updateTurn(id, turnId, () => ({
      schemaVersion: 1,
      turnId,
      state: initialTurnState(turnId),
      startedAt: new Date().toISOString(),
      ...clone(facts),
    }), true);
  }

  /** 用户消息与 Turn 起点一次写入，Remote 即使随后重启也不会留下空会话。 */
  async startTurnWithPrompt(
    id: string,
    turnId: string,
    prompt: SessionMessageEntry,
    facts: Partial<TurnExecutionRecord> = {},
  ): Promise<TurnExecutionRecord> {
    if (prompt.turnId !== turnId || prompt.role !== "user") throw new Error("Turn 起点必须绑定同一 Turn 的用户消息");
    return this.enqueueWrite(async () => {
      const sessions = await this.readAll();
      const session = requireSession(sessions, id);
      if (session.turns.some((turn) => turn.turnId === turnId)) throw new Error(`Turn 已存在: ${turnId}`);
      if (session.sessionEntries.some((entry) => entry.type === "message" && entry.messageId === prompt.messageId)) {
        throw new Error(`消息已存在: ${prompt.messageId}`);
      }
      const record: TurnExecutionRecord = {
        schemaVersion: 1,
        turnId,
        state: initialTurnState(turnId),
        startedAt: prompt.createdAt,
        ...clone(facts),
        promptEntryId: prompt.messageId,
      };
      session.sessionEntries.push(clone(prompt));
      session.turns.push(record);
      session.revision += 1;
      session.updatedAt = prompt.createdAt;
      if (session.title === "新对话") session.title = makeTitle(prompt.text);
      await this.save(sessions);
      return clone(record);
    });
  }

  /** 运行中增量合并已冻结事实；即使进程随后中断，已解析配置仍可审计。 */
  async checkpointTurn(
    id: string,
    turnId: string,
    facts: Partial<Omit<TurnExecutionRecord, "schemaVersion" | "turnId" | "state" | "startedAt" | "completedAt">>,
  ): Promise<TurnExecutionRecord> {
    return this.updateTurn(id, turnId, (current) => {
      if (current.state.status !== "active") throw new Error(`Turn 已结束，不能写入 checkpoint: ${turnId}`);
      return { ...current, ...clone(facts) };
    }, false);
  }

  async transitionTurn(
    id: string,
    turnId: string,
    phase: TurnActivePhase,
  ): Promise<TurnExecutionRecord> {
    return this.updateTurn(id, turnId, (current) => ({
      ...current,
      state: transitionActiveTurn(current.state, phase),
    }), false);
  }

  async addTurnInteraction(
    id: string,
    turnId: string,
    interaction: TurnPendingInteraction,
  ): Promise<TurnExecutionRecord> {
    return this.updateTurn(id, turnId, (current) => ({
      ...current,
      state: addPendingTurnInteraction(current.state, interaction),
    }), false);
  }

  async removeTurnInteraction(
    id: string,
    turnId: string,
    interactionId: string,
  ): Promise<TurnExecutionRecord> {
    return this.updateTurn(id, turnId, (current) => ({
      ...current,
      state: removePendingTurnInteraction(current.state, interactionId),
    }), false);
  }

  async checkpointTurnEntries(id: string, turnId: string, entries: SessionEntry[]): Promise<TurnExecutionRecord> {
    if (entries.length === 0) return this.requireTurn(id, turnId);
    return this.enqueueWrite(async () => {
      const sessions = await this.readAll();
      const session = requireSession(sessions, id);
      const turn = requireTurn(session, turnId);
      if (turn.state.status !== "active") throw new Error(`Turn 已结束，不能写入 entries: ${turnId}`);
      upsertEntries(session, entries);
      turn.entryIds = [...new Set([...(turn.entryIds ?? []), ...entries.map(entryIdentity)])];
      touch(session, entries.at(-1)?.createdAt ?? new Date().toISOString());
      await this.save(sessions);
      return clone(turn);
    });
  }

  /** 文件引用是已执行 Tool 的派生产物，可在 Turn 终态之后补齐，但不能改写 Turn 终态。 */
  async attachTurnFileReferences(
    id: string,
    turnId: string,
    entries: SessionEntry[],
    fileReferenceIds: string[],
  ): Promise<TurnExecutionRecord> {
    if (entries.length === 0 || fileReferenceIds.length === 0) return this.requireTurn(id, turnId);
    return this.enqueueWrite(async () => {
      const sessions = await this.readAll();
      const session = requireSession(sessions, id);
      const turn = requireTurn(session, turnId);
      upsertEntries(session, entries);
      turn.entryIds = [...new Set([...(turn.entryIds ?? []), ...entries.map(entryIdentity)])];
      turn.fileReferenceIds = [...new Set([...(turn.fileReferenceIds ?? []), ...fileReferenceIds])];
      touch(session, new Date().toISOString());
      await this.save(sessions);
      return clone(turn);
    });
  }

  async finishTurn(
    id: string,
    turnId: string,
    status: Exclude<TurnStatus, "active">,
    facts: Partial<Omit<TurnExecutionRecord, "schemaVersion" | "turnId" | "state" | "startedAt" | "completedAt">> = {},
  ): Promise<TurnExecutionRecord> {
    return this.updateTurn(id, turnId, (current) => ({
      ...current,
      ...clone(facts),
      state: finishTurnState(current.state, status),
      completedAt: new Date().toISOString(),
      ...(facts.fileReferenceIds?.length ? { fileReferenceIds: [...new Set(facts.fileReferenceIds)] } : {}),
    }), false);
  }

  async finishTurnWithEntries(
    id: string,
    turnId: string,
    status: Exclude<TurnStatus, "active">,
    entries: SessionEntry[],
    facts: Partial<Omit<TurnExecutionRecord, "schemaVersion" | "turnId" | "state" | "startedAt" | "completedAt">> = {},
  ): Promise<TurnExecutionRecord> {
    return this.enqueueWrite(async () => {
      const sessions = await this.readAll();
      const session = requireSession(sessions, id);
      const turn = requireTurn(session, turnId);
      upsertEntries(session, entries);
      const completedAt = new Date().toISOString();
      const next: TurnExecutionRecord = {
        ...turn,
        ...clone(facts),
        state: finishTurnState(turn.state, status),
        completedAt,
        entryIds: [...new Set([...(turn.entryIds ?? []), ...(facts.entryIds ?? []), ...entries.map(entryIdentity)])],
        ...(facts.fileReferenceIds?.length ? { fileReferenceIds: [...new Set(facts.fileReferenceIds)] } : {}),
      };
      const index = session.turns.findIndex((item) => item.turnId === turnId);
      session.turns[index] = next;
      touch(session, completedAt);
      await this.save(sessions);
      return clone(next);
    });
  }

  async persistMigrations(): Promise<void> {
    if (!this.migratedFrom) return;
    await this.enqueueWrite(async () => {
      const sessions = await this.readAll();
      const from = this.migratedFrom;
      if (!from) return;
      await copyFile(this.file, `${this.file}.v${from}.bak`);
      await this.save(sessions);
      this.migratedFrom = undefined;
    });
  }

  /** 进程启动时收敛上一个进程遗留的 Turn，并尽量修复旧版未及时保存的用户消息。 */
  async recoverInterruptedTurns(): Promise<number> {
    return this.enqueueWrite(async () => {
      const sessions = await this.readAll();
      const now = new Date().toISOString();
      let recovered = 0;
      let changed = false;
      for (const session of sessions) {
        let sessionChanged = false;
        for (let index = 0; index < session.turns.length; index += 1) {
          const turn = session.turns[index]!;
          if (turn.state.status !== "active") continue;
          const hasPrompt = session.sessionEntries.some((entry) =>
            entry.type === "message" && entry.role === "user" &&
            (entry.messageId === turn.promptEntryId || entry.turnId === turn.turnId));
          const promptText = hasPrompt ? undefined : recoverPromptText(turn);
          if (promptText) {
            const messageId = turn.promptEntryId ?? randomUUID();
            session.sessionEntries.push({
              type: "message",
              role: "user",
              text: promptText,
              turnId: turn.turnId,
              messageId,
              createdAt: turn.startedAt,
            });
            if (session.title === "新对话") session.title = makeTitle(promptText);
            turn.promptEntryId = messageId;
            turn.entryIds = [...new Set([`message:${messageId}`, ...(turn.entryIds ?? [])])];
          }
          session.turns[index] = {
            ...turn,
            state: interruptTurnState(turn.state),
            completedAt: now,
            error: {
              code: "TURN_INTERRUPTED",
              message: "Remote 服务重启，本轮生成已中断，可重新发送",
              retryable: true,
            },
          };
          recovered += 1;
          sessionChanged = true;
        }
        if (sessionChanged) {
          session.revision += 1;
          session.updatedAt = now;
          changed = true;
        }
      }
      if (changed) await this.save(sessions);
      return recovered;
    });
  }

  private async updateTurn(
    id: string,
    turnId: string,
    change: (record: TurnExecutionRecord) => TurnExecutionRecord,
    create: boolean,
  ): Promise<TurnExecutionRecord> {
    return this.enqueueWrite(async () => {
      const sessions = await this.readAll();
      const session = requireSession(sessions, id);
      const index = session.turns.findIndex((turn) => turn.turnId === turnId);
      if (create && index >= 0) throw new Error(`Turn 已存在: ${turnId}`);
      if (!create && index < 0) throw new Error(`Turn 不存在: ${turnId}`);
      const base = index < 0
        ? { schemaVersion: 1 as const, turnId, state: initialTurnState(turnId), startedAt: new Date().toISOString() }
        : session.turns[index]!;
      const record = change(base);
      if (index < 0) session.turns.push(record);
      else session.turns[index] = record;
      session.revision += 1;
      session.updatedAt = new Date().toISOString();
      await this.save(sessions);
      return clone(record);
    });
  }

  private async readAll(): Promise<SessionRecord[]> {
    if (this.cache) return this.cache;
    try {
      const data = JSON.parse(await readFile(this.file, "utf8")) as SessionFileV1 | SessionFileV2 | SessionFileV3 | SessionFileV4;
      if (!Array.isArray(data.sessions)) throw new Error("会话文件格式无效");
      if (data.version === 4) this.cache = data.sessions.map(validateV4);
      else {
        if (!this.legacyDefaults) throw new Error("旧 Session 迁移缺少默认 modelStudentId/agentId");
        this.migratedFrom = data.version;
        this.cache = migrateLegacy(data, this.legacyDefaults).map(validateV4);
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.cache = [];
    }
    return this.cache;
  }

  private async save(sessions: SessionRecord[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const data: SessionFileV4 = { version: 4, sessions };
    const temp = `${this.file}.tmp`;
    try { await copyFile(this.file, `${this.file}.bak`); } catch (error) { if (!isMissingFile(error)) throw error; }
    const handle = await open(temp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temp, this.file);
    const directory = await open(dirname(this.file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private get file(): string { return join(this.dir, "sessions.json"); }

  private async requireTurn(id: string, turnId: string): Promise<TurnExecutionRecord> {
    return requireTurn(await this.get(id), turnId);
  }
}

function validateCreate(input: CreateSessionInput): void {
  if (!isAbsolute(input.cwd)) throw new Error("cwd 必须是绝对路径");
  if (input.additionalDirectories?.some((item) => !isAbsolute(item))) throw new Error("additionalDirectories 必须是绝对路径");
  if (!input.ownerId || !input.modelStudentId || !input.agentId) throw new Error("Session 身份绑定不能为空");
  if (input.purpose === "experiment" && !input.experimentRef) throw new Error("experiment Session 必须有 experimentRef");
  if (input.purpose === "chat" && input.experimentRef) throw new Error("chat Session 不能有 experimentRef");
}

function recoverPromptText(turn: TurnExecutionRecord): string | undefined {
  const serialized = turn.modelRounds?.[0]?.providerInput;
  if (!serialized || serialized.format !== "json") return undefined;
  try {
    const request = JSON.parse(serialized.value) as unknown;
    if (!isRecord(request)) return undefined;
    const candidates = Array.isArray(request.messages)
      ? request.messages
      : Array.isArray(request.input) ? request.input : [];
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const item = candidates[index];
      if (!isRecord(item) || item.role !== "user") continue;
      if (typeof item.content === "string" && item.content.trim()) return item.content.trim();
    }
  } catch {
    // 旧 Provider 快照不可解析时只收敛状态，不臆造用户内容。
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateV4(session: SessionRecord): SessionRecord {
  validateCreate(session);
  if (session.schemaVersion !== 4 || !Array.isArray(session.sessionEntries) || !Array.isArray(session.turns)) {
    throw new Error("Session V4 格式无效");
  }
  if (session.reasoningOverride !== undefined && !isConcreteReasoningProfile(session.reasoningOverride)) {
    throw new Error("Session reasoningOverride 格式无效");
  }
  session.sessionEntries = session.sessionEntries.map((entry) => normalizeSessionEntry(session, entry));
  for (const turn of session.turns) {
    turn.state = readTurnState(turn.state);
    if (turn.state.turnId !== turn.turnId) throw new Error(`Turn state.turnId 不匹配: ${turn.turnId}`);
    if (turn.state.status === "active" && turn.completedAt) throw new Error(`活动 Turn 不得有 completedAt: ${turn.turnId}`);
    if (turn.state.status !== "active" && !turn.completedAt) throw new Error(`终态 Turn 缺少 completedAt: ${turn.turnId}`);
  }
  return session;
}

function migrateLegacy(data: SessionFileV1 | SessionFileV2 | SessionFileV3, defaults: LegacySessionDefaults): SessionRecord[] {
  return data.sessions.map((legacy) => {
    const sessionEntries = data.version === 1
      ? (legacy as SessionFileV1["sessions"][number]).messages.map((message) => ({ type: "message" as const, ...message }))
      : data.version === 2
        ? (legacy as SessionFileV2["sessions"][number]).entries
        : (legacy as SessionFileV3["sessions"][number]).sessionEntries;
    const createdAt = sessionEntries[0]?.createdAt ?? legacy.updatedAt;
    return {
      schemaVersion: 4,
      id: legacy.id,
      revision: data.version === 3 ? (legacy as SessionFileV3["sessions"][number]).revision : 0,
      ownerId: defaults.ownerId,
      purpose: "chat",
      cwd: legacy.cwd,
      additionalDirectories: [],
      title: legacy.title,
      modelStudentId: defaults.modelStudentId,
      agentId: defaults.agentId,
      createdAt,
      updatedAt: legacy.updatedAt,
      sessionEntries,
      turns: [],
    };
  });
}

function requireSession(sessions: SessionRecord[], id: string): SessionRecord {
  const session = sessions.find((item) => item.id === id);
  if (!session) throw new Error(`会话不存在: ${id}`);
  return session;
}

function requireTurn(session: SessionRecord, turnId: string): TurnExecutionRecord {
  const turn = session.turns.find((item) => item.turnId === turnId);
  if (!turn) throw new Error(`Turn 不存在: ${turnId}`);
  return turn;
}

function upsertEntries(session: SessionRecord, entries: SessionEntry[]): void {
  const indexes = new Map(session.sessionEntries.map((entry, index) => [entryIdentity(entry), index]));
  for (const entry of entries.map((item) => normalizeSessionEntry(session, item))) {
    const id = entryIdentity(entry);
    const index = indexes.get(id);
    if (index === undefined) {
      indexes.set(id, session.sessionEntries.length);
      session.sessionEntries.push(entry);
    } else {
      session.sessionEntries[index] = entry;
    }
  }
}

function normalizeSessionEntry(session: SessionRecord, entry: SessionEntry): SessionEntry {
  if (entry.type !== "provider_continuation") return clone(entry);
  const raw = entry as unknown as Record<string, unknown>;
  if (
    typeof raw.turnId !== "string" || raw.turnId.length === 0 ||
    !Number.isInteger(raw.roundIndex) || (raw.roundIndex as number) < 0 ||
    typeof raw.createdAt !== "string" || raw.createdAt.length === 0
  ) {
    throw new Error("Session provider continuation entry 格式无效");
  }
  const continuationRecord = isRecord(raw.continuation) ? raw.continuation : undefined;
  const legacy = continuationRecord?.schemaVersion === 1
    ? {
        modelStudentId: session.modelStudentId,
        messageIds: legacyIds(raw.visibleEntryIds, "visibleEntryIds"),
        toolCallIds: legacyIds(raw.toolCallIds, "toolCallIds"),
      }
    : undefined;
  const continuation = readProviderOpaqueContinuation(raw.continuation, legacy);
  if (continuation.modelStudentId !== session.modelStudentId) {
    throw new Error("Session provider continuation 与 Session ModelStudent 不匹配");
  }
  const turn = session.turns.find((item) => item.turnId === raw.turnId);
  if (
    turn?.providerKind && turn.providerKind !== continuation.providerKind ||
    turn?.model && turn.model !== continuation.model
  ) {
    throw new Error("Session provider continuation 与 Turn Provider / model 不匹配");
  }
  return {
    type: "provider_continuation",
    turnId: raw.turnId,
    roundIndex: raw.roundIndex as number,
    continuation,
    createdAt: raw.createdAt,
  };
}

function legacyIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`旧 Session provider continuation ${field} 格式无效`);
  }
  return [...new Set(value)];
}

function entryIdentity(entry: SessionEntry): string {
  if (entry.type === "message" || entry.type === "thought") return `${entry.type}:${entry.messageId}`;
  if (entry.type === "tool_call") return `tool:${entry.toolCallId}`;
  if (entry.type === "provider_continuation") return `provider:${entry.turnId}:${entry.roundIndex}`;
  return `${entry.type}:${entry.turnId}`;
}

function touch(session: SessionRecord, at: string): void {
  session.revision += 1;
  session.updatedAt = at;
}

function makeTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 28 ? `${oneLine.slice(0, 28)}…` : oneLine || "新对话";
}

function clone<T>(value: T): T { return structuredClone(value); }
function publicClone(value: SessionRecord): SessionRecord {
  const session = clone(value);
  session.sessionEntries = session.sessionEntries.filter((entry) => entry.type !== "provider_continuation");
  return session;
}
function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
