import { createServer, type Server } from "node:http";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { createNodeWebSocketUpgradeHandler } from "@agentclientprotocol/sdk/experimental/node";
import { WebSocketServer } from "ws";
import type { AgentApp } from "@agentclientprotocol/sdk";
import { Readable } from "node:stream";
import type { ControlApi } from "./control-api.js";

/**
 * Remote 的网络壳：HTTP 只提供健康检查，Agent 交互只走官方 ACP WebSocket。
 * 这个类也集中拥有三个网络资源，确保退出时不会残留连接。
 */
export class RemoteServer {
  readonly http: Server;
  private readonly acp: AcpServer;
  private readonly ws: WebSocketServer;

  constructor(
    agent: AgentApp,
    private readonly modelInfo: Record<string, string> = {},
    private readonly controlApi?: ControlApi,
  ) {
    this.acp = new AcpServer({ agent });
    this.ws = new WebSocketServer({ noServer: true });
    const upgrade = createNodeWebSocketUpgradeHandler(this.acp, this.ws);

    this.http = createServer(async (req, res) => {
      try {
        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({
            ok: true,
            service: "kindergarten-remote",
            modelStudent: this.modelInfo,
          }));
          return;
        }
        const request = toRequest(req);
        const response = await this.controlApi?.fetch(request);
        if (response) {
          await sendResponse(res, response);
          return;
        }
        res.writeHead(404).end();
      } catch (error) {
        if (res.headersSent) {
          res.destroy(error instanceof Error ? error : undefined);
          return;
        }
        const requestId = crypto.randomUUID();
        console.error(`[${requestId}] HTTP request failed`, error);
        res.writeHead(500, { "content-type": "application/problem+json; charset=utf-8" });
        res.end(JSON.stringify({
          type: "about:blank",
          title: "INTERNAL_ERROR",
          status: 500,
          detail: "Remote 处理请求失败",
          requestId,
          retryable: true,
        }));
      }
    });

    this.http.on("upgrade", (req, socket, head) => {
      if (new URL(req.url ?? "/", "http://localhost").pathname !== "/acp") {
        socket.destroy();
        return;
      }
      upgrade(req, socket, head);
    });
  }

  async listen(host: string, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(port, host, () => {
        this.http.off("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const httpClosed = closeHttp(this.http);
    await this.acp.close();
    await closeWebSockets(this.ws);
    await httpClosed;
  }
}

function toRequest(req: import("node:http").IncomingMessage): Request {
  const host = req.headers.host ?? "127.0.0.1";
  const method = req.method ?? "GET";
  return new Request(`http://${host}${req.url ?? "/"}`, {
    method,
    headers: headersFromNode(req.headers),
    ...(method === "GET" || method === "HEAD" ? {} : { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" }),
  } as RequestInit & { duplex?: "half" });
}

function headersFromNode(headers: import("node:http").IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) value.forEach((item) => result.append(key, item));
    else if (value !== undefined) result.set(key, value);
  }
  return result;
}

async function sendResponse(res: import("node:http").ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (!response.body) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    body.once("error", reject);
    res.once("finish", resolve);
    body.pipe(res);
  });
}

function closeHttp(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function closeWebSockets(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
