import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PinnedHttpTransport,
  type ResolvedHttpEndpoint,
} from "../../src/model/pinned-http-transport.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => {
  await Promise.all(servers.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(server) => new Promise<void>(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(resolve, reject) => {
    server.close(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(error) => error ? reject(error) : resolve());
  })));
});

describe("PinnedHttpTransport", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("把策略解析地址绑定到实际 socket，不对已审核 hostname 再做系统 DNS", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    let receivedHost: string | undefined;
    let receivedPath: string | undefined;
    const server = createServer(/** 构造「server」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(request, response) => {
      receivedHost = request.headers.host;
      receivedPath = request.url;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    servers.push(server);
    await new Promise<void>(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    // .invalid 必然无法由系统 DNS 解析；请求成功即证明 socket 使用的是策略票据地址。
    const url = new URL(`http://rebinding-probe.invalid:${port}/v1/chat/completions?probe=1`);
    const resolver = vi.fn(/** 构造「resolver」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async (requested: URL): Promise<ResolvedHttpEndpoint> => ({
      url: new URL(requested),
      addresses: [{ address: "127.0.0.1", family: 4 }],
    }));
    const transport = new PinnedHttpTransport(resolver);

    const response = await transport.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: new AbortController().signal,
    });

    expect(await response.json()).toEqual({ ok: true });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(receivedHost).toBe(`rebinding-probe.invalid:${port}`);
    expect(receivedPath).toBe("/v1/chat/completions?probe=1");
  });

  it("拒绝 URL 不一致或空地址的解析票据", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const url = new URL("https://models.example.test/v1/messages");
    await expect(new PinnedHttpTransport(/** 构造「request」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => ({
      url: new URL("https://other.example.test/v1/messages"),
      addresses: [{ address: "8.8.8.8", family: 4 }],
    })).request(url, { method: "POST" })).rejects.toThrow("URL 不一致");

    await expect(new PinnedHttpTransport(/** 构造「request」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async (requested) => ({
      url: new URL(requested),
      addresses: [],
    })).request(url, { method: "POST" })).rejects.toThrow("没有可用地址");
  });
});
