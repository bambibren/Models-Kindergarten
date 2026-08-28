import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import {
  isConcreteReasoningProfile,
  readTurnState,
  type ConcreteReasoningProfile,
  type ResolvedReasoningSnapshot,
  type TurnActivePhase,
  type TurnPendingInteraction,
  type TurnStatus,
} from "@kindergarten/contracts";
import { readProviderOpaqueContinuation } from "../model/provider-continuation.js";
import type { ModelContextSerialization } from "../model/model-provider.js";
import {
  addPendingTurnInteraction,
  finishTurnState,
  initialTurnState,
  interruptTurnState,
  removePendingTurnInteraction,
  transitionActiveTurn,
} from "./turn-state-machine.js";
import type {
  SessionEntry,
  SessionExperimentRef,
  SessionMessageEntry,
  SessionPurpose,
  SessionRecord,
  TurnExecutionRecord,
} from "./session-types.js";

type SessionRecordV4 = Omit<SessionRecord, "schemaVersion"> & { schemaVersion: 4 };
interface SessionFileV4 { version: 4; sessions: SessionRecordV4[] }
interface LegacySessionBase { id: string; cwd: string; title: string; updatedAt: string }
interface SessionFileV3 { version: 3; sessions: Array<LegacySessionBase & { revision: number; sessionEntries: SessionEntry[] }> }
interface SessionFileV2 { version: 2; sessions: Array<LegacySessionBase & { entries: SessionEntry[] }> }
interface SessionFileV1 { version: 1; sessions: Array<LegacySessionBase & { messages: Array<Omit<SessionMessageEntry, "type">> }> }

interface SessionMetadataV5 extends Omit<SessionRecord, "sessionEntries" | "turns"> {
  turnIds: string[];
  preview: string;
}

interface SessionIndexV5 {
  version: 5;
  sessions: SessionMetadataV5[];
}

interface TurnFileV5 {
  version: 5;
  turn: TurnExecutionRecord;
  entries: SessionEntry[];
}

interface ProviderEvidenceFileV1 {
  version: 1;
  sessionId: string;
  turnId: string;
  roundIndex: number;
  sha256: string;
  bytes: number;
  providerInput: ModelContextSerialization;
}

/** 描述「LegacySessionDefaults」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface LegacySessionDefaults {
  ownerId: string;
  modelStudentId: string;
  agentId: string;
}

/** 描述「CreateSessionInput」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface CreateSessionInput {
  cwd: string;
  additionalDirectories?: string[];
  ownerId: string;
  purpose: SessionPurpose;
  modelStudentId: string;
  agentId: string;
  experimentRef?: SessionExperimentRef;
  experimentReasoning?: ResolvedReasoningSnapshot;
}

/** 描述「SessionTurnPage」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SessionTurnPage {
  session: SessionRecord;
  hasMore: boolean;
  nextBeforeTurnId?: string;
}

/**
 * Repository V5 把 Session 元数据、单 Turn 事实和完整 Provider Input 分开存放。
 * 常规写入只读取目标 Turn；全量 `get` 仅用于 ACP `load` 等明确要求完整回放的入口。
 */
export class SessionRepository {
  private writeQueue: Promise<void> = Promise.resolve();
  private migration?: Promise<void>;

  /** 初始化「SessionRepository」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly dir: string,
    private readonly legacyDefaults?: LegacySessionDefaults,
  ) {}

  /** 根据已校验输入构建「create」结果，不额外持有调用方的大对象。 */
async create(input: CreateSessionInput): Promise<SessionRecord> {
    validateCreate(input);
    return this.enqueueWrite(/** 根据已校验输入构建「create」结果，不额外持有调用方的大对象。 */
async () => {
      await this.ensureV5();
      const now = new Date().toISOString();
      const session: SessionRecord = {
        schemaVersion: 5,
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
        ...(input.experimentReasoning ? { experimentReasoning: structuredClone(input.experimentReasoning) } : {}),
        createdAt: now,
        updatedAt: now,
        sessionEntries: [],
        turns: [],
      };
      await this.writeSession(session, []);
      return clone(session);
    });
  }

  /** 显式全量查询；控制面列表应改用 `listMetadata`，避免物化全部历史。 */
  async all(purpose?: SessionPurpose): Promise<SessionRecord[]> {
    await this.ensureV5();
    const index = await this.readIndex();
    const result: SessionRecord[] = [];
    for (const item of index.sessions) {
      if (!purpose || item.purpose === purpose) result.push(publicClone(await this.loadSession(item.id)));
    }
    return result;
  }

  /** 仅限 Runtime/Experiment 明确需要全量上下文的链路。 */
  async allForRuntime(purpose?: SessionPurpose): Promise<SessionRecord[]> {
    await this.ensureV5();
    const index = await this.readIndex();
    const result: SessionRecord[] = [];
    for (const item of index.sessions) {
      if (!purpose || item.purpose === purpose) result.push(await this.loadSession(item.id));
    }
    return result;
  }

  /** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
async get(id: string): Promise<SessionRecord> {
    await this.ensureV5();
    return clone(await this.loadSession(id));
  }

  /** Prompt Runtime 与 ACP 首屏按调用方给定窗口物化最近若干完整 Turn。 */
  async getRecent(id: string, maxTurns: number): Promise<SessionRecord> {
    if (!Number.isInteger(maxTurns) || maxTurns < 0) throw new Error("最近 Turn 数必须是非负整数");
    await this.ensureV5();
    const meta = await this.requireMetadata(id);
    return this.loadSession(id, maxTurns === 0 ? [] : meta.turnIds.slice(-maxTurns));
  }

  /** API/控制面过滤 Provider continuation，避免把适配器私有 payload 暴露到浏览器。 */
  async getPublic(id: string): Promise<SessionRecord> {
    return publicClone(await this.get(id));
  }

  /** Session 列表只读取 V5 小索引，不打开任何 Turn 文件。 */
  async list(cwd?: string | null, purpose: SessionPurpose = "chat"): Promise<SessionInfo[]> {
    await this.ensureV5();
    return (await this.readIndex()).sessions
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.purpose === purpose && (!cwd || item.cwd === cwd))
      .toSorted(/** 执行「map」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({ sessionId: item.id, cwd: item.cwd, title: item.title, updatedAt: item.updatedAt }));
  }

  /** 控制面列表所需字段直接来自索引，返回空的历史数组以防调用方误用。 */
  async listMetadata(purpose?: SessionPurpose): Promise<Array<SessionRecord & {
    indexedTurnCount: number;
    indexedPreview: string;
  }>> {
    await this.ensureV5();
    return (await this.readIndex()).sessions
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !purpose || item.purpose === purpose)
      .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({
        ...sessionFromMetadata(item),
        indexedTurnCount: item.turnIds.length,
        indexedPreview: item.preview,
      }));
  }

  /** 单 Session 控制面摘要同样只读索引。 */
  async getMetadata(id: string): Promise<SessionRecord & {
    indexedTurnCount: number;
    indexedPreview: string;
  }> {
    await this.ensureV5();
    const item = await this.requireMetadata(id);
    return {
      ...sessionFromMetadata(item),
      indexedTurnCount: item.turnIds.length,
      indexedPreview: item.preview,
    };
  }

  /** 执行「usesModelStudent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async usesModelStudent(modelStudentId: string): Promise<boolean> {
    await this.ensureV5();
    return (await this.readIndex()).sessions.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.modelStudentId === modelStudentId);
  }

  /** 通过索引中的 Turn ID 定位单个分片，避免为了 Context Lab 扫描所有 Session 正文。 */
  async findTurn(turnId: string, ownerId?: string): Promise<{ session: SessionRecord; turn: TurnExecutionRecord } | undefined> {
    await this.ensureV5();
    const meta = (await this.readIndex()).sessions.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) =>
      (!ownerId || item.ownerId === ownerId) && item.turnIds.includes(turnId));
    if (!meta) return undefined;
    const session = await this.loadSession(meta.id, [turnId]);
    const turn = session.turns[0];
    return turn ? { session, turn } : undefined;
  }

  /** Web 历史每页读取至多 `limit` 个完整 Turn，并返回向前翻页游标。 */
  async turnPage(id: string, limit = 20, beforeTurnId?: string): Promise<SessionTurnPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Turn 分页 limit 必须在 1 到 100 之间");
    await this.ensureV5();
    const meta = await this.requireMetadata(id);
    const end = beforeTurnId === undefined ? meta.turnIds.length : meta.turnIds.indexOf(beforeTurnId);
    if (end < 0) throw new Error(`分页 Turn 不存在: ${beforeTurnId}`);
    const start = Math.max(0, end - limit);
    const turnIds = meta.turnIds.slice(start, end);
    const session = publicClone(await this.loadSession(id, turnIds));
    return {
      session,
      hasMore: start > 0,
      ...(start > 0 && turnIds[0] ? { nextBeforeTurnId: turnIds[0] } : {}),
    };
  }

  /** 释放或删除「removeExperimentSessions」对应资源，重复调用仍保持安全。 */
async removeExperimentSessions(experimentId: string, ownerId = "local-admin"): Promise<string[]> {
    return this.enqueueWrite(/** 释放或删除「removeExperimentSessions」对应资源，重复调用仍保持安全。 */
async () => {
      await this.ensureV5();
      const index = await this.readIndex();
      const removed = index.sessions.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) =>
        item.ownerId === ownerId && item.purpose === "experiment" && item.experimentRef?.experimentId === experimentId);
      for (const item of removed) {
        await rm(this.sessionDir(item.id), { recursive: true, force: true });
      }
      if (removed.length > 0) {
        const removedIds = new Set(removed.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.id));
        await this.saveIndex({ version: 5, sessions: index.sessions.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !removedIds.has(item.id)) });
      }
      return removed.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.id);
    });
  }

  /** 更新「append」对应状态，并保持写入顺序、原子性与容量约束。 */
async append(id: string, entry: SessionEntry): Promise<void> {
    await this.appendMany(id, [entry]);
  }

  /** 更新「appendMany」对应状态，并保持写入顺序、原子性与容量约束。 */
async appendMany(id: string, entries: SessionEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.enqueueWrite(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
async () => {
      const turnIds = [...new Set(entries.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(entry) => entry.turnId))];
      await this.ensureV5();
      const meta = await this.requireMetadata(id);
      const existingTurnIds = turnIds.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(turnId) => meta.turnIds.includes(turnId));
      const session = await this.loadSession(id, existingTurnIds);
      for (const turnId of turnIds.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => !meta.turnIds.includes(candidate))) {
        const related = entries.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(entry) => entry.turnId === turnId);
        const startedAt = related[0]?.createdAt ?? new Date().toISOString();
        session.turns.push({
          schemaVersion: 1,
          turnId,
          state: finishTurnState(
            transitionActiveTurn(initialTurnState(turnId), "finalizing"),
            "completed",
          ),
          startedAt,
          completedAt: related.at(-1)?.createdAt ?? startedAt,
          entryIds: related.map(entryIdentity),
        });
      }
      const normalizedEntries = entries.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(entry) => normalizeSessionEntry(session, entry));
      upsertEntries(session, normalizedEntries);
      const last = normalizedEntries.at(-1);
      touch(session, last?.createdAt ?? new Date().toISOString());
      const firstUser = normalizedEntries.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(entry): entry is SessionMessageEntry =>
        entry.type === "message" && entry.role === "user");
      if (firstUser && session.title === "新对话") session.title = makeTitle(firstUser.text);
      await this.writeSession(session, turnIds);
    });
  }

  /** 更新「setReasoningOverride」对应状态，并保持写入顺序、原子性与容量约束。 */
async setReasoningOverride(id: string, profile: ConcreteReasoningProfile | undefined): Promise<SessionRecord> {
    return this.enqueueWrite(/** 更新「setReasoningOverride」对应状态，并保持写入顺序、原子性与容量约束。 */
async () => {
      const session = await this.loadForMutation(id, []);
      if (profile === undefined) delete session.reasoningOverride;
      else session.reasoningOverride = profile;
      touch(session, new Date().toISOString());
      await this.writeSession(session, []);
      return clone(session);
    });
  }

  /** 执行「startTurn」主流程，传播取消与失败并在结束时清理临时资源。 */
async startTurn(id: string, turnId: string, facts: Partial<TurnExecutionRecord> = {}): Promise<TurnExecutionRecord> {
    return this.updateTurn(id, turnId, /** 执行「startTurn」主流程，传播取消与失败并在结束时清理临时资源。 */
() => ({
      schemaVersion: 1,
      turnId,
      state: initialTurnState(turnId),
      startedAt: new Date().toISOString(),
      ...clone(facts),
    }), true);
  }

  /** 用户消息与 Turn 起点同写一个 Turn 分片，进程中断后不会留下空会话。 */
  async startTurnWithPrompt(
    id: string,
    turnId: string,
    prompt: SessionMessageEntry,
    facts: Partial<TurnExecutionRecord> = {},
  ): Promise<TurnExecutionRecord> {
    if (prompt.turnId !== turnId || prompt.role !== "user") throw new Error("Turn 起点必须绑定同一 Turn 的用户消息");
    return this.enqueueWrite(/** 执行「startTurnWithPrompt」主流程，传播取消与失败并在结束时清理临时资源。 */
async () => {
      const meta = await this.requireMetadata(id);
      if (meta.turnIds.includes(turnId)) throw new Error(`Turn 已存在: ${turnId}`);
      const session = sessionFromMetadata(meta);
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
      touch(session, prompt.createdAt);
      if (session.title === "新对话") session.title = makeTitle(prompt.text);
      await this.writeSession(session, [turnId]);
      return clone(record);
    });
  }

  /** 在目标 Turn 分片中合并运行检查点，保持已有终态和未涉及字段不被覆盖。 */
async checkpointTurn(
    id: string,
    turnId: string,
    facts: Partial<Omit<TurnExecutionRecord, "schemaVersion" | "turnId" | "state" | "startedAt" | "completedAt">>,
  ): Promise<TurnExecutionRecord> {
    return this.updateTurn(id, turnId, /** 执行「checkpointTurn」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => {
      if (current.state.status !== "active") throw new Error(`Turn 已结束，不能写入 checkpoint: ${turnId}`);
      return { ...current, ...clone(facts) };
    }, false);
  }

  /** 通过状态机校验后推进 Turn；非法倒退或重复终态直接拒绝。 */
async transitionTurn(id: string, turnId: string, phase: TurnActivePhase): Promise<TurnExecutionRecord> {
    return this.updateTurn(id, turnId, /** 执行「transitionTurn」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => ({
      ...current,
      state: transitionActiveTurn(current.state, phase),
    }), false);
  }

  /** 执行「addTurnInteraction」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async addTurnInteraction(id: string, turnId: string, interaction: TurnPendingInteraction): Promise<TurnExecutionRecord> {
    return this.updateTurn(id, turnId, /** 执行「addTurnInteraction」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => ({
      ...current,
      state: addPendingTurnInteraction(current.state, interaction),
    }), false);
  }

  /** 释放或删除「removeTurnInteraction」对应资源，重复调用仍保持安全。 */
async removeTurnInteraction(id: string, turnId: string, interactionId: string): Promise<TurnExecutionRecord> {
    return this.updateTurn(id, turnId, /** 释放或删除「removeTurnInteraction」对应资源，重复调用仍保持安全。 */
(current) => ({
      ...current,
      state: removePendingTurnInteraction(current.state, interactionId),
    }), false);
  }

  /** 原子写入当前 Turn 的增量 Entry，并以稳定身份去重，供断线恢复读取。 */
async checkpointTurnEntries(id: string, turnId: string, entries: SessionEntry[]): Promise<TurnExecutionRecord> {
    if (entries.length === 0) return this.requireTurn(id, turnId);
    return this.enqueueWrite(/** 执行「checkpointTurnEntries」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async () => {
      const session = await this.loadForMutation(id, [turnId]);
      const turn = requireTurn(session, turnId);
      if (turn.state.status !== "active") throw new Error(`Turn 已结束，不能写入 entries: ${turnId}`);
      upsertEntries(session, entries);
      turn.entryIds = [...new Set([...(turn.entryIds ?? []), ...entries.map(entryIdentity)])];
      touch(session, entries.at(-1)?.createdAt ?? new Date().toISOString());
      await this.writeSession(session, [turnId]);
      return clone(requireTurn(session, turnId));
    });
  }

  /** 终态后的 FileReference 只追加派生引用，不改写 Turn 状态。 */
  async attachTurnFileReferences(id: string, turnId: string, entries: SessionEntry[], fileReferenceIds: string[]): Promise<TurnExecutionRecord> {
    if (entries.length === 0 || fileReferenceIds.length === 0) return this.requireTurn(id, turnId);
    return this.enqueueWrite(/** 执行「attachTurnFileReferences」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async () => {
      const session = await this.loadForMutation(id, [turnId]);
      const turn = requireTurn(session, turnId);
      upsertEntries(session, entries);
      turn.entryIds = [...new Set([...(turn.entryIds ?? []), ...entries.map(entryIdentity)])];
      turn.fileReferenceIds = [...new Set([...(turn.fileReferenceIds ?? []), ...fileReferenceIds])];
      touch(session, new Date().toISOString());
      await this.writeSession(session, [turnId]);
      return clone(turn);
    });
  }

  /** 提交 Turn 终态事实；终态写入后不得被活动检查点覆盖。 */
async finishTurn(
    id: string,
    turnId: string,
    status: Exclude<TurnStatus, "active">,
    facts: Partial<Omit<TurnExecutionRecord, "schemaVersion" | "turnId" | "state" | "startedAt" | "completedAt">> = {},
  ): Promise<TurnExecutionRecord> {
    return this.updateTurn(id, turnId, /** 执行「finishTurn」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => ({
      ...current,
      ...clone(facts),
      state: finishTurnState(current.state, status),
      completedAt: new Date().toISOString(),
      ...(facts.fileReferenceIds?.length ? { fileReferenceIds: [...new Set(facts.fileReferenceIds)] } : {}),
    }), false);
  }

  /** 在同一 Session 写队列中同时提交末尾 Entry、使用量和 Turn 终态，避免可见半状态。 */
async finishTurnWithEntries(
    id: string,
    turnId: string,
    status: Exclude<TurnStatus, "active">,
    entries: SessionEntry[],
    facts: Partial<Omit<TurnExecutionRecord, "schemaVersion" | "turnId" | "state" | "startedAt" | "completedAt">> = {},
  ): Promise<TurnExecutionRecord> {
    return this.enqueueWrite(/** 执行「finishTurnWithEntries」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async () => {
      const session = await this.loadForMutation(id, [turnId]);
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
      session.turns[0] = next;
      touch(session, completedAt);
      await this.writeSession(session, [turnId]);
      return clone(session.turns[0]!);
    });
  }

  /** V5 迁移在索引原子切换前已经完成；保留方法供启动组合根显式等待。 */
  async persistMigrations(): Promise<void> {
    await this.ensureV5();
  }

  /** 逐 Turn 扫描活动状态，一次只物化一个分片。 */
  async recoverInterruptedTurns(): Promise<number> {
    return this.enqueueWrite(/** 执行「recoverInterruptedTurns」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async () => {
      await this.ensureV5();
      const index = await this.readIndex();
      let recovered = 0;
      for (const meta of index.sessions) {
        for (const turnId of meta.turnIds) {
          const session = await this.loadSession(meta.id, [turnId]);
          const turn = session.turns[0];
          if (!turn || turn.state.status !== "active") continue;
          const hasPrompt = session.sessionEntries.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(entry) =>
            entry.type === "message" && entry.role === "user" &&
            (entry.messageId === turn.promptEntryId || entry.turnId === turn.turnId));
          const promptText = hasPrompt ? undefined : await this.recoverPromptText(meta.id, turn);
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
          const now = new Date().toISOString();
          session.turns[0] = {
            ...turn,
            state: interruptTurnState(turn.state),
            completedAt: now,
            error: {
              code: "TURN_INTERRUPTED",
              message: "Remote 服务重启，本轮生成已中断，可重新发送",
              retryable: true,
            },
          };
          touch(session, now);
          await this.writeSession(session, [turnId]);
          recovered += 1;
        }
      }
      return recovered;
    });
  }

  /** Context Lab 明确请求时才读取完整 Provider Input，并校验引用、字节数和哈希。 */
  async readProviderInput(sessionId: string, turnId: string, roundIndex: number): Promise<ModelContextSerialization> {
    await this.ensureV5();
    const session = await this.loadSession(sessionId, [turnId]);
    const round = requireTurn(session, turnId).modelRounds?.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.roundIndex === roundIndex);
    if (!round?.providerInputRef || !round.providerInputHash || round.providerInputBytes === undefined) {
      throw new Error(`Provider Input evidence 不存在: ${turnId}/${roundIndex}`);
    }
    const value = JSON.parse(await readFile(this.evidenceFile(sessionId, turnId, roundIndex), "utf8")) as ProviderEvidenceFileV1;
    if (
      value.version !== 1 || value.sessionId !== sessionId || value.turnId !== turnId ||
      value.roundIndex !== roundIndex || value.sha256 !== round.providerInputHash || value.bytes !== round.providerInputBytes
    ) {
      throw new Error("Provider Input evidence 身份或元数据不匹配");
    }
    const actualHash = createHash("sha256").update(value.providerInput.value).digest("hex");
    const actualBytes = Buffer.byteLength(value.providerInput.value);
    if (actualHash !== value.sha256 || actualBytes !== value.bytes) {
      throw new Error("Provider Input evidence 哈希校验失败");
    }
    return structuredClone(value.providerInput);
  }

  /** 更新「updateTurn」对应状态，并保持写入顺序、原子性与容量约束。 */
private async updateTurn(
    id: string,
    turnId: string,
    change: (record: TurnExecutionRecord) => TurnExecutionRecord,
    create: boolean,
  ): Promise<TurnExecutionRecord> {
    return this.enqueueWrite(/** 更新「updateTurn」对应状态，并保持写入顺序、原子性与容量约束。 */
async () => {
      const meta = await this.requireMetadata(id);
      const exists = meta.turnIds.includes(turnId);
      if (create && exists) throw new Error(`Turn 已存在: ${turnId}`);
      if (!create && !exists) throw new Error(`Turn 不存在: ${turnId}`);
      const session = exists
        ? await this.loadSession(id, [turnId])
        : sessionFromMetadata(meta);
      const base = exists
        ? requireTurn(session, turnId)
        : { schemaVersion: 1 as const, turnId, state: initialTurnState(turnId), startedAt: new Date().toISOString() };
      const record = change(base);
      if (exists) session.turns[0] = record;
      else session.turns.push(record);
      touch(session, new Date().toISOString());
      await this.writeSession(session, [turnId]);
      return clone(session.turns.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.turnId === turnId)!);
    });
  }

  /** 校验并取得「requireTurn」所需对象；缺失或归属不符时立即抛出明确错误。 */
private async requireTurn(id: string, turnId: string): Promise<TurnExecutionRecord> {
    return requireTurn(await this.loadForMutation(id, [turnId]), turnId);
  }

  /** 读取「loadForMutation」所需数据，并遵守作用域、分页与容量边界。 */
private async loadForMutation(id: string, turnIds: string[]): Promise<SessionRecord> {
    await this.ensureV5();
    return this.loadSession(id, turnIds);
  }

  /** 确保 V5 索引可读；首次访问旧布局时先完成全部分片，再原子切换索引。 */
private ensureV5(): Promise<void> {
    this.migration ??= this.migrateToV5();
    return this.migration;
  }

  /** 先备份旧文件并写完所有分片，最后原子写索引作为 V5 切换点。 */
  private async migrateToV5(): Promise<void> {
    try {
      const current = JSON.parse(await readFile(this.indexFile, "utf8")) as SessionIndexV5;
      if (current.version !== 5 || !Array.isArray(current.sessions)) throw new Error("Session V5 索引格式无效");
      return;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }

    let legacy: SessionFileV1 | SessionFileV2 | SessionFileV3 | SessionFileV4 | undefined;
    try {
      legacy = JSON.parse(await readFile(this.legacyFile, "utf8")) as typeof legacy;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    if (!legacy) {
      await this.saveIndex({ version: 5, sessions: [] });
      return;
    }
    if (!Array.isArray(legacy.sessions)) throw new Error("旧 Session 文件格式无效");
    const from = legacy.version;
    const sessions = from === 4
      ? legacy.sessions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => validateV5({ ...item, schemaVersion: 5 }))
      : this.legacyDefaults
        ? migrateLegacy(legacy as SessionFileV1 | SessionFileV2 | SessionFileV3, this.legacyDefaults).map(validateV5)
        : (/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => { throw new Error("旧 Session 迁移缺少默认 modelStudentId/agentId"); })();
    await copyFile(this.legacyFile, `${this.legacyFile}.v${from}.bak`);
    const metadata: SessionMetadataV5[] = [];
    for (const session of sessions) {
      const existingTurnIds = new Set(session.turns.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(turn) => turn.turnId));
      for (const turnId of [...new Set(session.sessionEntries.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(entry) => entry.turnId))]) {
        if (existingTurnIds.has(turnId)) continue;
        const entries = session.sessionEntries.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(entry) => entry.turnId === turnId);
        const startedAt = entries[0]?.createdAt ?? session.createdAt;
        session.turns.push({
          schemaVersion: 1,
          turnId,
          state: interruptTurnState(initialTurnState(turnId)),
          startedAt,
          completedAt: session.updatedAt,
          entryIds: entries.map(entryIdentity),
          error: {
            code: "TURN_INTERRUPTED",
            message: "旧 Session 没有 Turn 终态，迁移时已收敛为中断",
            retryable: true,
          },
        });
      }
      const normalizedTurns: TurnExecutionRecord[] = [];
      for (const turn of session.turns) {
        const normalized = await this.persistTurnEvidence(session.id, turn);
        normalizedTurns.push(normalized);
        await this.writeTurnFile(session.id, normalized, session.sessionEntries.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(entry) => entry.turnId === turn.turnId));
      }
      session.turns = normalizedTurns;
      const meta = metadataFromSession(session, session.turns.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(turn) => turn.turnId));
      await this.writeMetadataFile(meta);
      metadata.push(meta);
    }
    await this.saveIndex({ version: 5, sessions: metadata });
  }

  /** 读取「readIndex」所需数据，并遵守作用域、分页与容量边界。 */
private async readIndex(): Promise<SessionIndexV5> {
    const value = JSON.parse(await readFile(this.indexFile, "utf8")) as SessionIndexV5;
    if (value.version !== 5 || !Array.isArray(value.sessions)) throw new Error("Session V5 索引格式无效");
    return value;
  }

  /** 校验并取得「requireMetadata」所需对象；缺失或归属不符时立即抛出明确错误。 */
private async requireMetadata(id: string): Promise<SessionMetadataV5> {
    await this.ensureV5();
    const item = (await this.readIndex()).sessions.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate.id === id);
    if (!item) throw new Error(`会话不存在: ${id}`);
    return structuredClone(item);
  }

  /** 读取「loadSession」所需数据，并遵守作用域、分页与容量边界。 */
private async loadSession(id: string, selectedTurnIds?: string[]): Promise<SessionRecord> {
    const meta = await this.requireMetadata(id);
    const wanted = selectedTurnIds ?? meta.turnIds;
    const turns: TurnExecutionRecord[] = [];
    const sessionEntries: SessionEntry[] = [];
    for (const turnId of wanted) {
      if (!meta.turnIds.includes(turnId)) throw new Error(`Turn 不存在: ${turnId}`);
      const file = await this.readTurnFile(id, turnId);
      turns.push(file.turn);
      sessionEntries.push(...file.entries);
    }
    return validateV5({
      ...sessionFromMetadata(meta),
      turns,
      sessionEntries,
    });
  }

  /** 写入目标 Turn 与 Session 元数据；索引中的其他 Turn ID 必须原样保留。 */
  private async writeSession(session: SessionRecord, changedTurnIds: string[]): Promise<void> {
    await mkdir(this.sessionDir(session.id), { recursive: true });
    const index = await this.readIndex();
    const previous = index.sessions.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.id === session.id);
    const turnIds = [...(previous?.turnIds ?? [])];
    for (const turnId of changedTurnIds) {
      if (!turnIds.includes(turnId)) turnIds.push(turnId);
      const turn = requireTurn(session, turnId);
      const persisted = await this.persistTurnEvidence(session.id, turn);
      const turnIndex = session.turns.findIndex(/** 执行「turnIndex」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item.turnId === turnId);
      session.turns[turnIndex] = persisted;
      await this.writeTurnFile(
        session.id,
        persisted,
        session.sessionEntries.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(entry) => entry.turnId === turnId),
      );
    }
    const meta = metadataFromSession(session, turnIds, previous?.preview);
    await this.writeMetadataFile(meta);
    const sessions = index.sessions.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.id !== session.id);
    sessions.push(meta);
    await this.saveIndex({ version: 5, sessions });
  }

  /** 完整 Provider Input 先写 evidence，再从 Turn 记录删除正文。 */
  private async persistTurnEvidence(sessionId: string, turn: TurnExecutionRecord): Promise<TurnExecutionRecord> {
    if (!turn.modelRounds) return clone(turn);
    const rounds = [];
    for (const round of turn.modelRounds) {
      if (!round.providerInput) {
        rounds.push(clone(round));
        continue;
      }
      const providerInput = structuredClone(round.providerInput);
      const hash = createHash("sha256").update(providerInput.value).digest("hex");
      const bytes = Buffer.byteLength(providerInput.value);
      const evidence: ProviderEvidenceFileV1 = {
        version: 1,
        sessionId,
        turnId: turn.turnId,
        roundIndex: round.roundIndex,
        sha256: hash,
        bytes,
        providerInput,
      };
      const file = this.evidenceFile(sessionId, turn.turnId, round.roundIndex);
      await mkdir(dirname(file), { recursive: true });
      await atomicWrite(file, `${JSON.stringify(evidence, null, 2)}\n`);
      const { providerInput: _providerInput, ...light } = round;
      rounds.push({
        ...light,
        providerInputRef: `evidence/${turnKey(turn.turnId)}/${round.roundIndex}.json`,
        providerInputHash: hash,
        providerInputBytes: bytes,
        providerInputProvider: providerInput.provider,
        providerInputModel: providerInput.model,
        providerInputFormat: providerInput.format,
      });
    }
    return { ...clone(turn), modelRounds: rounds };
  }

  /** 执行「recoverPromptText」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private async recoverPromptText(sessionId: string, turn: TurnExecutionRecord): Promise<string | undefined> {
    const firstRound = turn.modelRounds?.[0];
    if (!firstRound) return undefined;
    let serialized = firstRound.providerInput;
    if (!serialized && firstRound.providerInputRef) {
      serialized = await this.readProviderInput(sessionId, turn.turnId, firstRound.roundIndex).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
    }
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
      // Provider evidence 不可解析时只收敛 Turn 状态，不臆造用户正文。
    }
    return undefined;
  }

  /** 读取「readTurnFile」所需数据，并遵守作用域、分页与容量边界。 */
private async readTurnFile(sessionId: string, turnId: string): Promise<TurnFileV5> {
    const value = JSON.parse(await readFile(this.turnFile(sessionId, turnId), "utf8")) as TurnFileV5;
    if (value.version !== 5 || value.turn.turnId !== turnId || !Array.isArray(value.entries)) {
      throw new Error("Session Turn 分片格式或身份不匹配");
    }
    return structuredClone(value);
  }

  /** 更新「writeTurnFile」对应状态，并保持写入顺序、原子性与容量约束。 */
private async writeTurnFile(sessionId: string, turn: TurnExecutionRecord, entries: SessionEntry[]): Promise<void> {
    const file = this.turnFile(sessionId, turn.turnId);
    await mkdir(dirname(file), { recursive: true });
    const value: TurnFileV5 = { version: 5, turn, entries };
    await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
  }

  /** 更新「writeMetadataFile」对应状态，并保持写入顺序、原子性与容量约束。 */
private async writeMetadataFile(meta: SessionMetadataV5): Promise<void> {
    const file = join(this.sessionDir(meta.id), "session.json");
    await mkdir(dirname(file), { recursive: true });
    await atomicWrite(file, `${JSON.stringify(meta, null, 2)}\n`);
  }

  /** 更新「saveIndex」对应状态，并保持写入顺序、原子性与容量约束。 */
private async saveIndex(index: SessionIndexV5): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await atomicWrite(this.indexFile, `${JSON.stringify(index, null, 2)}\n`);
  }

  /** 按 Session key 串行写入；Promise settle 后删除队列项，避免长期保留已完成链。 */
private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined, /** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
    return result;
  }

  /** 根据受控标识构造「sessionDir」路径；调用方仍须执行归属与目录边界校验。 */
private sessionDir(sessionId: string): string {
    return join(this.dir, "sessions", sessionKey(sessionId));
  }

  /** 根据受控标识构造「turnFile」路径；调用方仍须执行归属与目录边界校验。 */
private turnFile(sessionId: string, turnId: string): string {
    return join(this.sessionDir(sessionId), "turns", `${turnKey(turnId)}.json`);
  }

  /** 根据受控标识构造「evidenceFile」路径；调用方仍须执行归属与目录边界校验。 */
private evidenceFile(sessionId: string, turnId: string, roundIndex: number): string {
    return join(this.sessionDir(sessionId), "evidence", turnKey(turnId), `${roundIndex}.json`);
  }

  /** 根据受控标识构造「indexFile」路径；调用方仍须执行归属与目录边界校验。 */
private get indexFile(): string {
    return join(this.dir, "sessions.index.json");
  }

  /** 根据受控标识构造「legacyFile」路径；调用方仍须执行归属与目录边界校验。 */
private get legacyFile(): string {
    return join(this.dir, "sessions.json");
  }
}

/** 原子替换前同步临时文件，保证读取者只看到旧文件或完整新文件。 */
async function atomicWrite(file: string, content: string): Promise<void> {
  const temp = `${file}.tmp`;
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
}

/** 校验并规范化「validateCreate」输入，非法数据直接返回明确错误。 */
function validateCreate(input: CreateSessionInput): void {
  if (!isAbsolute(input.cwd)) throw new Error("cwd 必须是绝对路径");
  if (input.additionalDirectories?.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !isAbsolute(item))) throw new Error("additionalDirectories 必须是绝对路径");
  if (!input.ownerId || !input.modelStudentId || !input.agentId) throw new Error("Session 身份绑定不能为空");
  if (input.purpose === "experiment" && !input.experimentRef) throw new Error("experiment Session 必须有 experimentRef");
  if (input.purpose === "chat" && input.experimentRef) throw new Error("chat Session 不能有 experimentRef");
}

/** V5 读取时重新校验 Session 身份、Reasoning 和 Turn 终态不变量。 */
function validateV5(session: SessionRecord): SessionRecord {
  validateCreate(session);
  if (session.schemaVersion !== 5 || !Array.isArray(session.sessionEntries) || !Array.isArray(session.turns)) {
    throw new Error("Session V5 格式无效");
  }
  if (session.reasoningOverride !== undefined && !isConcreteReasoningProfile(session.reasoningOverride)) {
    throw new Error("Session reasoningOverride 格式无效");
  }
  session.sessionEntries = session.sessionEntries.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(entry) => normalizeSessionEntry(session, entry));
  for (const turn of session.turns) {
    turn.state = readTurnState(turn.state);
    if (turn.state.turnId !== turn.turnId) throw new Error(`Turn state.turnId 不匹配: ${turn.turnId}`);
    if (turn.state.status === "active" && turn.completedAt) throw new Error(`活动 Turn 不得有 completedAt: ${turn.turnId}`);
    if (turn.state.status !== "active" && !turn.completedAt) throw new Error(`终态 Turn 缺少 completedAt: ${turn.turnId}`);
  }
  return session;
}

/** 把 V1～V4 聚合记录转换为 V5 分片，并校验证据哈希后保留版本化备份。 */
function migrateLegacy(
  data: SessionFileV1 | SessionFileV2 | SessionFileV3,
  defaults: LegacySessionDefaults,
): SessionRecord[] {
  return data.sessions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(legacy) => {
    const sessionEntries = data.version === 1
      ? (legacy as SessionFileV1["sessions"][number]).messages.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(message) => ({ type: "message" as const, ...message }))
      : data.version === 2
        ? (legacy as SessionFileV2["sessions"][number]).entries
        : (legacy as SessionFileV3["sessions"][number]).sessionEntries;
    const createdAt = sessionEntries[0]?.createdAt ?? legacy.updatedAt;
    return {
      schemaVersion: 5,
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

/** 执行「metadataFromSession」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function metadataFromSession(
  session: SessionRecord,
  turnIds: string[],
  previousPreview = "",
): SessionMetadataV5 {
  const { sessionEntries: _entries, turns: _turns, ...base } = session;
  const lastUser = session.sessionEntries.findLast(/** 执行「lastUser」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(entry) => entry.type === "message" && entry.role === "user");
  return {
    ...clone(base),
    turnIds: [...turnIds],
    preview: lastUser?.type === "message" ? lastUser.text.slice(0, 160) : previousPreview,
  };
}

/** 执行「sessionFromMetadata」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function sessionFromMetadata(meta: SessionMetadataV5): SessionRecord {
  const { turnIds: _turnIds, preview: _preview, ...base } = meta;
  return { ...clone(base), sessionEntries: [], turns: [] };
}

/** 校验并取得「requireTurn」所需对象；缺失或归属不符时立即抛出明确错误。 */
function requireTurn(session: SessionRecord, turnId: string): TurnExecutionRecord {
  const turn = session.turns.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.turnId === turnId);
  if (!turn) throw new Error(`Turn 不存在: ${turnId}`);
  return turn;
}

/** 执行「upsertEntries」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function upsertEntries(session: SessionRecord, entries: SessionEntry[]): void {
  const indexes = new Map(session.sessionEntries.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(entry, index) => [entryIdentity(entry), index]));
  for (const entry of entries.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => normalizeSessionEntry(session, item))) {
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

/** 校验并规范化「normalizeSessionEntry」输入，非法数据直接返回明确错误。 */
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
  const turn = session.turns.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.turnId === raw.turnId);
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

/** 执行「legacyIds」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function legacyIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`旧 Session provider continuation ${field} 格式无效`);
  }
  return [...new Set(value)];
}

/** 由规范字段生成稳定的「entryIdentity」标识，供索引精确定位且不保留原始大对象。 */
function entryIdentity(entry: SessionEntry): string {
  if (entry.type === "message" || entry.type === "thought") return `${entry.type}:${entry.messageId}`;
  if (entry.type === "tool_call") return `tool:${entry.toolCallId}`;
  if (entry.type === "provider_continuation") return `provider:${entry.turnId}:${entry.roundIndex}`;
  return `${entry.type}:${entry.turnId}`;
}

/** 根据已校验输入构建「touch」结果，不额外持有调用方的大对象。 */
function touch(session: SessionRecord, at: string): void {
  session.revision += 1;
  session.updatedAt = at;
}

/** 根据已校验输入构建「makeTitle」结果，不额外持有调用方的大对象。 */
function makeTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 28 ? `${oneLine.slice(0, 28)}…` : oneLine || "新对话";
}

/** 由规范字段生成稳定的「sessionKey」标识，供索引精确定位且不保留原始大对象。 */
function sessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

/** 由规范字段生成稳定的「turnKey」标识，供索引精确定位且不保留原始大对象。 */
function turnKey(turnId: string): string {
  return createHash("sha256").update(turnId).digest("hex");
}

/** 复制「clone」返回值，防止调用方通过共享引用修改仓储内部状态。 */
function clone<T>(value: T): T { return structuredClone(value); }

/** 复制「publicClone」返回值，防止调用方通过共享引用修改仓储内部状态。 */
function publicClone(value: SessionRecord): SessionRecord {
  const session = clone(value);
  session.sessionEntries = session.sessionEntries.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(entry) => entry.type !== "provider_continuation");
  return session;
}

/** 判断「isRecord」对应条件，只返回判定结果且不修改输入状态。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判断「isMissingFile」对应条件，只返回判定结果且不修改输入状态。 */
function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
