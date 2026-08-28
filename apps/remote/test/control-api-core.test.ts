import { describe, expect, it } from "vitest";
import { ControlApi } from "../src/server/control-api.js";
import { ApiProblemError } from "../src/server/api-problem.js";

describe("Control API core", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
function api(): ControlApi {
    const value = new ControlApi({ allowedOrigins: ["http://127.0.0.1:5174"] });
    value.router.register("GET", "/echo/:id", /** 构造「api」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ params, url }) => ({ id: params.id, query: url.searchParams.get("q") }));
    value.router.register("POST", "/items", /** 构造「api」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async ({ json }) => ({ body: await json() }));
    value.router.register("GET", "/failure", /** 构造「api」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => {
      throw new ApiProblemError(409, "CONFLICT", "资源冲突", false);
    });
    return value;
  }

  it("返回统一 success/problem envelope 与 requestId", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const success = await api().fetch(new Request("http://127.0.0.1/api/control/v1/echo/a?q=x"));
    expect(success?.status).toBe(200);
    expect(success?.headers.get("x-request-id")).toBeTruthy();
    expect(await success?.json()).toMatchObject({ data: { id: "a", query: "x" }, requestId: expect.any(String) });

    const failure = await api().fetch(new Request("http://127.0.0.1/api/control/v1/failure"));
    expect(failure?.status).toBe(409);
    expect(failure?.headers.get("content-type")).toContain("application/problem+json");
    expect(await failure?.json()).toMatchObject({ code: "CONFLICT", requestId: expect.any(String) });
  });

  it("拒绝未授权写 Origin、Origin null 与超限 JSON", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
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

  it("没有 Content-Length 的分块 JSON 也会在读取过程中停止于大小上限", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      /** 构造「pull」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
pull(controller) {
        pulls += 1;
        controller.enqueue(encoder.encode("x".repeat(40)));
        if (pulls >= 10) controller.close();
      },
    });
    const limited = new ControlApi({
      allowedOrigins: ["http://127.0.0.1:5174"],
      maxJsonBytes: 64,
    });
    limited.router.register("POST", "/items", /** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
async ({ json }) => ({ body: await json() }));

    const response = await limited.fetch(new Request("http://127.0.0.1/api/control/v1/items", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:5174",
        "content-type": "application/json",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" }));

    expect(response?.status).toBe(413);
    expect(pulls).toBeLessThan(10);
  });

  it("并发 Handler 达到上限时立即拒绝且完成后归还名额", /** 验证容量门禁不排无界等待队列，并在 finally 中释放计数。 */
async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(/** 暴露首个 Handler 已经占用名额的确定时点。 */
(resolve) => { enter = resolve; });
    const blocked = new Promise<void>(/** 由测试控制慢 Handler 的结束时点。 */
(resolve) => { release = resolve; });
    const limited = new ControlApi({
      allowedOrigins: ["http://127.0.0.1:5174"],
      maxConcurrentRequests: 1,
    });
    limited.router.register("GET", "/slow", /** 保持首个请求在 Handler 内，便于验证第二个请求不会排队。 */
async () => { enter(); await blocked; return { ok: true }; });

    const first = limited.fetch(new Request("http://127.0.0.1/api/control/v1/slow"));
    await entered;
    const rejected = await limited.fetch(new Request("http://127.0.0.1/api/control/v1/slow"));
    expect(rejected?.status).toBe(503);
    expect(await rejected?.json()).toMatchObject({ code: "REMOTE_BUSY", retryable: true });

    release();
    expect((await first)?.status).toBe(200);
    expect((await limited.fetch(new Request("http://127.0.0.1/api/control/v1/slow")))?.status).toBe(200);
  });

  it("区分 unknown route 404 与已知 path method 405", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
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
