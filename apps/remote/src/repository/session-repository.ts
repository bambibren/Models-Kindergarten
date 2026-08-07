import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import type {
  SessionEntry,
  SessionMessageEntry,
  SessionRecord,
} from "./session-types.js";

interface SessionFileV3 {
  version: 3;
  sessions: SessionRecord[];
}

interface SessionFileV2 {
  version: 2;
  sessions: Array<Omit<SessionRecord, "sessionEntries" | "revision"> & { entries: SessionEntry[] }>;
}

interface SessionFileV1 {
  version: 1;
  sessions: Array<Omit<SessionRecord, "sessionEntries" | "revision"> & {
    messages: Array<Omit<SessionMessageEntry, "type">>;
  }>;
}

/** Repository V3 原子保存 SessionEntry 事实；旧文件只在读取边界迁移。 */
export class SessionRepository {
  private cache?: SessionRecord[];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  async create(cwd: string): Promise<SessionRecord> {
    if (!isAbsolute(cwd)) throw new Error("cwd 必须是绝对路径");

    return this.enqueueWrite(async () => {
      const sessions = await this.readAll();
      const now = new Date().toISOString();
      const session: SessionRecord = {
        id: randomUUID(),
        revision: 0,
        cwd,
        title: "新对话",
        updatedAt: now,
        sessionEntries: [],
      };
      sessions.push(session);
      await this.save(sessions);
      return clone(session);
    });
  }

  async get(id: string): Promise<SessionRecord> {
    const sessions = await this.readAll();
    const session = sessions.find((item) => item.id === id);
    if (!session) throw new Error(`会话不存在: ${id}`);
    return clone(session);
  }

  async list(cwd?: string | null): Promise<SessionInfo[]> {
    const sessions = await this.readAll();
    return sessions
      .filter((item) => !cwd || item.cwd === cwd)
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((item) => ({
        sessionId: item.id,
        cwd: item.cwd,
        title: item.title,
        updatedAt: item.updatedAt,
      }));
  }

  async append(id: string, entry: SessionEntry): Promise<void> {
    await this.appendMany(id, [entry]);
  }

  async appendMany(id: string, entries: SessionEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.enqueueWrite(async () => {
      const sessions = await this.readAll();
      const session = sessions.find((item) => item.id === id);
      if (!session) throw new Error(`会话不存在: ${id}`);

      session.sessionEntries.push(...clone(entries));
      session.revision += 1;
      const last = entries.at(-1);
      if (last) session.updatedAt = last.createdAt;
      const firstUser = entries.find(
        (entry): entry is SessionMessageEntry =>
          entry.type === "message" && entry.role === "user",
      );
      if (firstUser && session.title === "新对话") {
        session.title = makeTitle(firstUser.text);
      }
      await this.save(sessions);
    });
  }

  private async readAll(): Promise<SessionRecord[]> {
    if (this.cache) return this.cache;

    try {
      const text = await readFile(this.file, "utf8");
      const data = JSON.parse(text) as SessionFileV1 | SessionFileV2 | SessionFileV3;
      if (!Array.isArray(data.sessions)) throw new Error("会话文件格式无效");
      if (data.version === 3) {
        this.cache = data.sessions.map((session) => ({
          ...session,
          revision: Number.isInteger(session.revision) ? session.revision : 0,
        }));
      }
      else if (data.version === 2) this.cache = migrateV2(data);
      else if (data.version === 1) this.cache = migrateV1(data);
      else throw new Error("会话文件版本无效");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.cache = [];
    }
    return this.cache;
  }

  private async save(sessions: SessionRecord[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const data: SessionFileV3 = { version: 3, sessions };
    const temp = `${this.file}.tmp`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temp, this.file);
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private get file(): string {
    return join(this.dir, "sessions.json");
  }
}

function migrateV1(data: SessionFileV1): SessionRecord[] {
  return data.sessions.map(({ messages, ...session }) => ({
    ...session,
    revision: 0,
    sessionEntries: messages.map((message) => ({ type: "message" as const, ...message })),
  }));
}

function migrateV2(data: SessionFileV2): SessionRecord[] {
  return data.sessions.map(({ entries, ...session }) => ({
    ...session,
    revision: 0,
    sessionEntries: entries,
  }));
}

function makeTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 28 ? `${oneLine.slice(0, 28)}…` : oneLine || "新对话";
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
