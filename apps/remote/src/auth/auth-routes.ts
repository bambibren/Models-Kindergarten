import { ApiProblemError } from "../server/api-problem.js";
import type { ControlRouter } from "../server/control-router.js";
import { AuthService, publicPrincipal } from "./auth-service.js";

export const AUTH_PUBLIC_PATHS = ["/auth/login", "/auth/session", "/auth/logout"];

export function registerAuthRoutes(router: ControlRouter, auth: AuthService): void {
  router.register("POST", "/auth/login", async ({ json }) => {
    const input = loginInput(await json());
    try {
      const result = await auth.login(input.username, input.password);
      return jsonResponse({ authenticated: true, principal: publicPrincipal(result.principal) }, result.setCookie);
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_LOGIN") {
        throw new ApiProblemError(401, "AUTHENTICATION_REQUIRED", "用户名或密码错误", false);
      }
      throw error;
    }
  });
  router.register("GET", "/auth/session", async ({ request }) => {
    const principal = await auth.resolve(request);
    if (!principal) throw new ApiProblemError(401, "AUTHENTICATION_REQUIRED", "请先登录", false);
    return jsonResponse({ authenticated: true, principal: publicPrincipal(principal) });
  });
  router.register("POST", "/auth/logout", async ({ request }) =>
    jsonResponse({ authenticated: false }, await auth.logout(request)));
}

function loginInput(value: unknown): { username: string; password: string } {
  if (!isRecord(value) || typeof value.username !== "string" || typeof value.password !== "string") {
    throw new ApiProblemError(400, "VALIDATION_FAILED", "请输入用户名和密码", false);
  }
  return { username: value.username, password: value.password };
}

function jsonResponse(data: unknown, setCookie?: string): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(setCookie ? { "set-cookie": setCookie } : {}),
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
