import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { AtomicJsonStore } from "../storage/atomic-json-store.js";
import type { AuthPrincipal, AuthUserView, CreatedLoginSession } from "./auth-types.js";

const scrypt = promisify(scryptCallback);
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

interface AuthUserRecord {
  schemaVersion: 1;
  principalId: string;
  username: string;
  normalizedUsername: string;
  salt: string;
  passwordHash: string;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AuthSessionRecord {
  schemaVersion: 1;
  tokenHash: string;
  principalId: string;
  createdAt: string;
  expiresAt: string;
}

export class PasswordAuthStore {
  private readonly users: AtomicJsonStore<AuthUserRecord>;
  private readonly sessions: AtomicJsonStore<AuthSessionRecord>;

  constructor(
    usersFile: string,
    sessionsFile: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.users = new AtomicJsonStore({ file: usersFile, schemaVersion: 1, validate: isUserRecord });
    this.sessions = new AtomicJsonStore({ file: sessionsFile, schemaVersion: 1, validate: isSessionRecord });
  }

  async add(username: string, password: string): Promise<AuthPrincipal> {
    const normalizedUsername = normalizeUsername(username);
    validatePassword(password);
    const salt = randomBytes(16);
    const passwordHash = await derivePassword(password, salt);
    const timestamp = this.now().toISOString();
    const record: AuthUserRecord = {
      schemaVersion: 1,
      principalId: `user_${randomUUID()}`,
      username: username.trim(),
      normalizedUsername,
      salt: salt.toString("base64"),
      passwordHash: passwordHash.toString("base64"),
      disabled: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.users.update((records) => {
      if (records.some((item) => item.normalizedUsername === normalizedUsername)) {
        throw new Error(`账号已存在: ${record.username}`);
      }
      return [...records, record];
    });
    return principal(record);
  }

  async list(): Promise<AuthUserView[]> {
    return (await this.users.read())
      .map((item) => ({ ...principal(item), disabled: item.disabled, createdAt: item.createdAt }))
      .toSorted((left, right) => left.username.localeCompare(right.username));
  }

  async verify(username: string, password: string): Promise<AuthPrincipal | undefined> {
    let normalizedUsername: string;
    try { normalizedUsername = normalizeUsername(username); }
    catch { return undefined; }
    const user = (await this.users.read()).find((item) => item.normalizedUsername === normalizedUsername);
    if (!user || user.disabled) return undefined;
    const actual = await derivePassword(password, Buffer.from(user.salt, "base64"));
    const expected = Buffer.from(user.passwordHash, "base64");
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? principal(user) : undefined;
  }

  async resetPassword(username: string, password: string): Promise<void> {
    const normalizedUsername = normalizeUsername(username);
    validatePassword(password);
    const salt = randomBytes(16);
    const passwordHash = await derivePassword(password, salt);
    const principalId = await this.updateUser(normalizedUsername, (item) => ({
      ...item,
      salt: salt.toString("base64"),
      passwordHash: passwordHash.toString("base64"),
      updatedAt: this.now().toISOString(),
    }));
    await this.revokeAll(principalId);
  }

  async disable(username: string): Promise<void> {
    const principalId = await this.updateUser(normalizeUsername(username), (item) => ({
      ...item,
      disabled: true,
      updatedAt: this.now().toISOString(),
    }));
    await this.revokeAll(principalId);
  }

  async enable(username: string): Promise<void> {
    await this.updateUser(normalizeUsername(username), (item) => ({
      ...item,
      disabled: false,
      updatedAt: this.now().toISOString(),
    }));
  }

  async remove(username: string): Promise<{ principalId: string }> {
    const normalizedUsername = normalizeUsername(username);
    const principalId = await this.users.update((records) => {
      const user = records.find((item) => item.normalizedUsername === normalizedUsername);
      if (!user) throw new Error(`账号不存在: ${username}`);
      return { records: records.filter((item) => item !== user), result: user.principalId };
    });
    if (!principalId) throw new Error(`账号不存在: ${username}`);
    await this.revokeAll(principalId);
    return { principalId };
  }

  async createSession(principalId: string): Promise<CreatedLoginSession> {
    const user = (await this.users.read()).find((item) => item.principalId === principalId && !item.disabled);
    if (!user) throw new Error("账号不存在或已禁用");
    const token = randomBytes(32).toString("base64url");
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + SESSION_LIFETIME_MS);
    const record: AuthSessionRecord = {
      schemaVersion: 1,
      tokenHash: tokenHash(token),
      principalId,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    await this.sessions.update((records) => [
      ...records.filter((item) => Date.parse(item.expiresAt) > createdAt.getTime()),
      record,
    ]);
    return { token, expiresAt: record.expiresAt };
  }

  async resolveSession(token: string): Promise<AuthPrincipal | undefined> {
    if (!token) return undefined;
    const now = this.now().getTime();
    const session = (await this.sessions.read()).find((item) =>
      item.tokenHash === tokenHash(token) && Date.parse(item.expiresAt) > now);
    if (!session) return undefined;
    const user = (await this.users.read()).find((item) => item.principalId === session.principalId && !item.disabled);
    return user ? principal(user) : undefined;
  }

  async revokeSession(token: string): Promise<void> {
    const hash = tokenHash(token);
    await this.sessions.update((records) => records.filter((item) => item.tokenHash !== hash));
  }

  async revokeAll(principalId: string): Promise<void> {
    await this.sessions.update((records) => records.filter((item) => item.principalId !== principalId));
  }

  async enabledCount(): Promise<number> {
    return (await this.users.read()).filter((item) => !item.disabled).length;
  }

  private async updateUser(
    normalizedUsername: string,
    change: (record: AuthUserRecord) => AuthUserRecord,
  ): Promise<string> {
    const principalId = await this.users.update((records) => {
      const index = records.findIndex((item) => item.normalizedUsername === normalizedUsername);
      if (index < 0) throw new Error(`账号不存在: ${normalizedUsername}`);
      const current = records[index]!;
      const next = [...records];
      next[index] = change(current);
      return { records: next, result: current.principalId };
    });
    if (!principalId) throw new Error(`账号不存在: ${normalizedUsername}`);
    return principalId;
  }
}

function normalizeUsername(value: string): string {
  const username = value.trim();
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) {
    throw new Error("用户名必须为 3–32 位英文字母、数字、下划线或连字符");
  }
  return username.toLowerCase();
}

function validatePassword(value: string): void {
  if (value.length < 8 || value.length > 256) throw new Error("密码长度必须为 8–256 位");
}

async function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return Buffer.from(await scrypt(password, salt, 32) as Buffer);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function principal(user: AuthUserRecord): AuthPrincipal {
  return { schemaVersion: 1, principalId: user.principalId, kind: "password_user", username: user.username };
}

function isUserRecord(value: unknown): value is AuthUserRecord {
  return isRecord(value) && value.schemaVersion === 1 && typeof value.principalId === "string" &&
    typeof value.username === "string" && typeof value.normalizedUsername === "string" &&
    typeof value.salt === "string" && typeof value.passwordHash === "string" &&
    typeof value.disabled === "boolean" && typeof value.createdAt === "string" && typeof value.updatedAt === "string";
}

function isSessionRecord(value: unknown): value is AuthSessionRecord {
  return isRecord(value) && value.schemaVersion === 1 && typeof value.tokenHash === "string" &&
    typeof value.principalId === "string" && typeof value.createdAt === "string" && typeof value.expiresAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
