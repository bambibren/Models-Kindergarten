import { describe, expect, it } from "vitest";
import { ControlApi } from "../src/server/control-api.js";
import { ApiProblemError } from "../src/server/api-problem.js";

describe("Control API core", () => {
  function api(): ControlApi {
    const value = new ControlApi({ allowedOrigins: ["http://127.0.0.1:5174"] });
    value.router.register("GET", "/echo/:id", ({ params, url }) => ({ id: params.id, query: url.searchParams.get("q") }));
    value.router.register("POST", "/items", async ({ json }) => ({ body: await json() }));
    value.router.register("GET", "/failure", () => {
      throw new ApiProblemError(409, "CONFLICT", "资源冲突", false);
    });
    return value;
  }

  it("返回统一 success/problem envelope 与 requestId", async () => {
    const success = await api().fetch(new Request("http://127.0.0.1/api/control/v1/echo/a?q=x"));
    expect(success?.status).toBe(200);
    expect(success?.headers.get("x-request-id")).toBeTruthy();
    expect(await success?.json()).toMatchObject({ data: { id: "a", query: "x" }, requestId: expect.any(String) });

    const failure = await api().fetch(new Request("http://127.0.0.1/api/control/v1/failure"));
    expect(failure?.status).toBe(409);
    expect(failure?.headers.get("content-type")).toContain("application/problem+json");
    expect(await failure?.json()).toMatchObject({ code: "CONFLICT", requestId: expect.any(String) });
  });

  it("拒绝未授权写 Origin、Origin null 与超限 JSON", async () => {
    const denied = await api().fetch(new Request("http://127.0.0.1/api/control/v1/items", {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: "{}",
    }));
    expect(denied?.status).toBe(403);
    expect(await denied?.json()).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });

    const nullOrigin = await api().fetch(new Request("http://127.0.0.1/api/control/v1/items", {
      method: "POST",
      headers: { origin: "null", "content-type": "application/json" },
      body: "{}",
    }));
    expect(nullOrigin?.status).toBe(403);

    const allowed = await api().fetch(new Request("http://127.0.0.1/api/control/v1/items", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:5174", "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    }));
    expect(allowed?.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5174");
    expect(await allowed?.json()).toMatchObject({ data: { body: { ok: true } } });
  });

  it("区分 unknown route 404 与已知 path method 405", async () => {
    const missing = await api().fetch(new Request("http://127.0.0.1/api/control/v1/missing"));
    expect(missing?.status).toBe(404);
    const wrongMethod = await api().fetch(new Request("http://127.0.0.1/api/control/v1/echo/a", {
      method: "DELETE",
      headers: { origin: "http://127.0.0.1:5174" },
    }));
    expect(wrongMethod?.status).toBe(405);
    expect(wrongMethod?.headers.get("allow")).toBe("GET");
  });
});
