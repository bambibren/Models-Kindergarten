import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import type { StoredEntry, StoredMessage, StoredSession } from "./session-types.js";

interface SessionFileV2 {
  version: 2;
  sessions: StoredSession[];
}

interface SessionFileV1 {
  version: 1;
  sessions: Array<Omit<StoredSession, "entries"> & {
    messages: Array<Omit<StoredMessage, "type">>;
  }>;
}

/** JSON Repository 保存稳定聊天投影；V1 文件会在内存中无损迁移到 V2。 */
export class SessionRepository {
  private cache?: StoredSession[];

  constructor(private readonly dir: string) {}

  async create(cwd: string): Promise<StoredSession> {
    if (!isAbsolute(cwd)) throw new Error("cwd 必须是绝对路径");

    const sessions = await this.readAll();
    const now = new Date().toISOString();
    const session: StoredSession = {
      id: randomUUID(),
      cwd,
      title: "新对话",
      updatedAt: now,
      entries: [],
    };
    sessions.push(session);
    await this.save(sessions);
    return clone(session);
  }

  async get(id: string): Promise<StoredSession> {
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

  async append(id: string, entry: StoredEntry): Promise<void> {
    await this.appendMany(id, [entry]);
  }

  async appendMany(id: string, entries: StoredEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const sessions = await this.readAll();
    const session = sessions.find((item) => item.id === id);
    if (!session) throw new Error(`会话不存在: ${id}`);

    session.entries.push(...clone(entries));
    const last = entries.at(-1);
    if (last) session.updatedAt = last.createdAt;
    const firstUser = entries.find(
      (entry): entry is StoredMessage =>
        entry.type === "message" && entry.role === "user",
    );
    if (firstUser && session.title === "新对话") {
      session.title = makeTitle(firstUser.text);
    }
    await this.save(sessions);
  }

  private async readAll(): Promise<StoredSession[]> {
    if (this.cache) return this.cache;

    try {
      const text = await readFile(this.file, "utf8");
      const data = JSON.parse(text) as SessionFileV1 | SessionFileV2;
      if (!Array.isArray(data.sessions)) throw new Error("会话文件格式无效");
      if (data.version === 2) this.cache = data.sessions;
      else if (data.version === 1) this.cache = migrateV1(data);
      else throw new Error("会话文件版本无效");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.cache = [];
    }
    return this.cache;
  }

  private async save(sessions: StoredSession[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const data: SessionFileV2 = { version: 2, sessions };
    const temp = `${this.file}.tmp`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temp, this.file);
  }

  private get file(): string {
    return join(this.dir, "sessions.json");
  }
}

function migrateV1(data: SessionFileV1): StoredSession[] {
  return data.sessions.map(({ messages, ...session }) => ({
    ...session,
    entries: messages.map((message) => ({ type: "message" as const, ...message })),
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
