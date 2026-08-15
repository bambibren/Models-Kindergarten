import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PinnedHttpTransport,
  type ResolvedHttpEndpoint,
} from "../../src/model/pinned-http-transport.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("PinnedHttpTransport", () => {
  it("把策略解析地址绑定到实际 socket，不对已审核 hostname 再做系统 DNS", async () => {
    let receivedHost: string | undefined;
    let receivedPath: string | undefined;
    const server = createServer((request, response) => {
      receivedHost = request.headers.host;
      receivedPath = request.url;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    // .invalid 必然无法由系统 DNS 解析；请求成功即证明 socket 使用的是策略票据地址。
    const url = new URL(`http://rebinding-probe.invalid:${port}/v1/chat/completions?probe=1`);
    const resolver = vi.fn(async (requested: URL): Promise<ResolvedHttpEndpoint> => ({
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

  it("拒绝 URL 不一致或空地址的解析票据", async () => {
    const url = new URL("https://models.example.test/v1/messages");
    await expect(new PinnedHttpTransport(async () => ({
      url: new URL("https://other.example.test/v1/messages"),
      addresses: [{ address: "8.8.8.8", family: 4 }],
    })).request(url, { method: "POST" })).rejects.toThrow("URL 不一致");

    await expect(new PinnedHttpTransport(async (requested) => ({
      url: new URL(requested),
      addresses: [],
    })).request(url, { method: "POST" })).rejects.toThrow("没有可用地址");
  });
});
