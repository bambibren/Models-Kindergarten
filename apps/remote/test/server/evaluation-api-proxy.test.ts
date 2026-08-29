import { describe, expect, it, vi } from "vitest";
import { EvaluationApiProxy } from "../../src/server/evaluation-api-proxy.js";

describe("EvaluationApiProxy", () => {
  it("只把同源评测读取路径映射到固定服务地址", async () => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ ok: true }));
    const proxy = new EvaluationApiProxy("http://evaluation:7441", request);

    const response = await proxy.fetch(new Request("http://remote/api/evaluation/v1/turn-evaluations/s-1/t-1?view=full"));

    expect(response?.status).toBe(200);
    expect(String(request.mock.calls[0]?.[0])).toBe("http://evaluation:7441/api/v1/turn-evaluations/s-1/t-1?view=full");
    await expect(proxy.fetch(new Request("http://remote/api/control/v1/sessions"))).resolves.toBeUndefined();
  });

  it("拒绝浏览器写入且把下游不可用收敛成 502", async () => {
    const proxy = new EvaluationApiProxy("http://evaluation:7441", async () => { throw new Error("offline"); });
    expect((await proxy.fetch(new Request("http://remote/api/evaluation/v1/turns", { method: "POST" })))?.status).toBe(405);
    expect((await proxy.fetch(new Request("http://remote/api/evaluation/v1/turns")))?.status).toBe(502);
  });
});
