import { createServer, type Server } from "node:http";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { createNodeWebSocketUpgradeHandler } from "@agentclientprotocol/sdk/experimental/node";
import { WebSocketServer } from "ws";
import type { AgentApp } from "@agentclientprotocol/sdk";

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
  ) {
    this.acp = new AcpServer({ agent });
    this.ws = new WebSocketServer({ noServer: true });
    const upgrade = createNodeWebSocketUpgradeHandler(this.acp, this.ws);

    this.http = createServer((req, res) => {
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
      res.writeHead(404).end();
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
