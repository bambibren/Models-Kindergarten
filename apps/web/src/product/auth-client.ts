export interface AuthSessionView {
  authenticated: true;
  principal: { principalId: string; username: string; kind: "local_admin" | "password_user" };
}

export async function readAuthSession(): Promise<AuthSessionView | undefined> {
  const response = await fetch("/api/control/v1/auth/session", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (response.status === 401) return undefined;
  if (!response.ok) throw new Error(`登录状态检查失败（${response.status}）`);
  return (await response.json() as { data: AuthSessionView }).data;
}

export async function login(username: string, password: string): Promise<AuthSessionView> {
  const response = await fetch("/api/control/v1/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => undefined) as { detail?: string } | undefined;
    throw new Error(problem?.detail ?? "用户名或密码错误");
  }
  return (await response.json() as { data: AuthSessionView }).data;
}

export async function logout(): Promise<void> {
  const response = await fetch("/api/control/v1/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error(`退出登录失败（${response.status}）`);
}

export function safeNextPath(search: string): string {
  const candidate = new URLSearchParams(search).get("next") ?? "/";
  return candidate.startsWith("/") && !candidate.startsWith("//") ? candidate : "/";
}
