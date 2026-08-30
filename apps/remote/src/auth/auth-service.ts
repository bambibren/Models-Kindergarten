import type { Principal } from "@kindergarten/contracts";
import { localPrincipal } from "../server/local-principal.js";
import type { AuthMode } from "../config/deployment-config.js";
import { PasswordAuthStore } from "./password-auth-store.js";

export const SESSION_COOKIE = "mk_session";
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export class AuthService {
  constructor(private readonly mode: AuthMode, readonly store: PasswordAuthStore) {}

  async resolve(request: Request): Promise<Principal | undefined> {
    if (this.mode === "development") return localPrincipal;
    const token = cookieValue(request.headers.get("cookie"), SESSION_COOKIE);
    return token ? this.store.resolveSession(token) : undefined;
  }

  async login(username: string, password: string): Promise<{ principal: Principal; setCookie?: string }> {
    if (this.mode === "development") return { principal: localPrincipal };
    const principal = await this.store.verify(username, password);
    if (!principal) throw new Error("INVALID_LOGIN");
    const session = await this.store.createSession(principal.principalId);
    return { principal, setCookie: sessionCookie(session.token) };
  }

  async logout(request: Request): Promise<string> {
    const token = cookieValue(request.headers.get("cookie"), SESSION_COOKIE);
    if (token && this.mode === "required") await this.store.revokeSession(token);
    return expiredSessionCookie();
  }
}

export function publicPrincipal(value: Principal): { principalId: string; username: string; kind: Principal["kind"] } {
  return {
    principalId: value.principalId,
    username: value.kind === "password_user" ? value.username : "local-admin",
    kind: value.kind,
  };
}

function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    try { return decodeURIComponent(value); }
    catch { return undefined; }
  }
  return undefined;
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
}

function expiredSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
