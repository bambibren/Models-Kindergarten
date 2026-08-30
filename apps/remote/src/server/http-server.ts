import { createServer, type IncomingMessage, type Server } from "node:http";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { WebSocketServer } from "ws";
import type { AgentApp } from "@agentclientprotocol/sdk";
import { Duplex, Readable } from "node:stream";
import type { ControlApi } from "./control-api.js";
import { PRODUCT_CONFIG, type Principal } from "@kindergarten/contracts";

const MAX_ACP_INCOMING_PAYLOAD_BYTES = 1024 * 1024;

export interface HttpFeature {
  fetch(request: Request, principal?: Principal): Promise<Response | undefined>;
}

export interface RemoteServerAuthentication {
  resolve(request: Request): Promise<Principal | undefined>;
  createAgent(principal: Principal): AgentApp;
}

/**
 * Remote 的网络壳：HTTP 提供健康检查、控制 API 和 Evaluation 读取，Agent 交互走官方 ACP WebSocket。
 * 这个类也集中拥有三个网络资源，确保退出时不会残留连接。
 */
export class RemoteServer {
  readonly http: Server;
  private readonly acp: AcpServer;
  private readonly ws: WebSocketServer;

  /** 初始化「RemoteServer」所需依赖，不在构造阶段启动不可回收的后台任务。 */
  constructor(
    agent: AgentApp,
    private readonly modelInfo: Record<string, string> = {},
    private readonly controlApi?: ControlApi,
    private readonly evaluationApi?: HttpFeature,
    private readonly readiness: Record<string, boolean> = { server: true },
    private readonly authentication?: RemoteServerAuthentication,
  ) {
    this.acp = new AcpServer({ agent });
    this.ws = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_ACP_INCOMING_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });
    this.http = createServer(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
async (req, res) => {
      try {
        if (req.method === "GET" && (req.url === "/health" || req.url === "/health/live")) {
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
        if (req.method === "GET" && req.url === "/health/ready") {
          const ready = Object.values(this.readiness).every(Boolean);
          res.writeHead(ready ? 200 : 503, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            ok: ready,
            service: "kindergarten-remote",
            checks: this.readiness,
            modelStudent: this.modelInfo,
          }));
          return;
        }
        const request = toRequest(req);
        let principal: Principal | undefined;
        if (this.authentication && !isPublicAuthenticationRequest(request)) {
          principal = await this.authentication.resolve(request);
          if (!principal) {
            await sendResponse(res, authenticationRequiredResponse());
            return;
          }
        }
        const evaluationResponse = await this.evaluationApi?.fetch(request, principal);
        if (evaluationResponse) {
          await sendResponse(res, evaluationResponse);
          return;
        }
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
    // TCP、请求头、请求体和 keep-alive 分别设上界，避免未进入业务 Handler 的慢连接无限占用对象。
    this.http.maxConnections = PRODUCT_CONFIG.server.maxHttpConnections;
    this.http.requestTimeout = PRODUCT_CONFIG.server.requestTimeoutMs;
    this.http.headersTimeout = PRODUCT_CONFIG.server.headersTimeoutMs;
    this.http.keepAliveTimeout = PRODUCT_CONFIG.server.keepAliveTimeoutMs;
    this.http.maxRequestsPerSocket = PRODUCT_CONFIG.server.maxRequestsPerSocket;

    this.http.on("upgrade", /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(req, socket, head) => {
      if (new URL(req.url ?? "/", "http://localhost").pathname !== "/acp") {
        socket.destroy();
        return;
      }
      if (this.ws.clients.size >= PRODUCT_CONFIG.server.maxAcpConnections) {
        // 拒绝发生在 WebSocket/ACP 对象创建前，因此不会生成需要排队清理的半连接。
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
        return;
      }
      void this.upgrade(req, socket, head);
    });
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      const principal = this.authentication ? await this.authentication.resolve(toRequest(req)) : undefined;
      if (this.authentication && !principal) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      const prepared = this.acp.prepareWebSocketUpgrade(
        this.authentication && principal ? { agent: this.authentication.createAgent(principal) } : undefined,
      );
      let accepted = false;
      const cleanup = () => {
        this.ws.off("headers", onHeaders);
        socket.off("close", onFailed);
        socket.off("error", onFailed);
      };
      const onHeaders = (headers: string[], request: IncomingMessage) => {
        if (request === req) headers.push(`Acp-Connection-Id: ${prepared.connectionId}`);
      };
      const onFailed = () => {
        if (accepted) return;
        cleanup();
        prepared.reject();
      };
      this.ws.on("headers", onHeaders);
      socket.once("close", onFailed);
      socket.once("error", onFailed);
      this.ws.handleUpgrade(req, socket, head, (webSocket) => {
        accepted = true;
        cleanup();
        prepared.accept(webSocket);
      });
    } catch (error) {
      console.error("ACP WebSocket 登录校验失败", error);
      rejectUpgrade(socket, 500, "Internal Server Error");
    }
  }

  /** 读取「listen」所需数据，并遵守作用域、分页与容量边界。 */
async listen(host: string, port: number): Promise<void> {
    await new Promise<void>(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(port, host, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => {
        this.http.off("error", reject);
        resolve();
      });
    });
  }

  /** 释放或删除「close」对应资源，重复调用仍保持安全。 */
async close(): Promise<void> {
    const httpClosed = closeHttp(this.http);
    await this.acp.close();
    await closeWebSockets(this.ws);
    await httpClosed;
  }
}

function isPublicAuthenticationRequest(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return path === "/api/control/v1/auth/login" ||
    path === "/api/control/v1/auth/session" ||
    path === "/api/control/v1/auth/logout" ||
    /^\/api\/control\/v1\/onlyoffice\/artifacts\/[^/]+\/raw$/u.test(path);
}

function authenticationRequiredResponse(): Response {
  return Response.json({
    type: "about:blank",
    title: "需要登录",
    status: 401,
    detail: "请先登录 Models Kindergarten",
    code: "AUTHENTICATION_REQUIRED",
    retryable: false,
  }, {
    status: 401,
    headers: { "content-type": "application/problem+json; charset=utf-8" },
  });
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** 根据已校验输入构建「toRequest」结果，不额外持有调用方的大对象。 */
function toRequest(req: import("node:http").IncomingMessage): Request {
  const host = req.headers.host ?? "127.0.0.1";
  const method = req.method ?? "GET";
  return new Request(`http://${host}${req.url ?? "/"}`, {
    method,
    headers: headersFromNode(req.headers),
    ...(method === "GET" || method === "HEAD" ? {} : { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" }),
  } as RequestInit & { duplex?: "half" });
}

/** 执行「headersFromNode」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function headersFromNode(headers: import("node:http").IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) value.forEach(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(item) => result.append(key, item));
    else if (value !== undefined) result.set(key, value);
  }
  return result;
}

/** 执行「sendResponse」主流程，传播取消与失败并在结束时清理临时资源。 */
async function sendResponse(res: import("node:http").ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (!response.body) {
    res.end();
    return;
  }
  await new Promise<void>(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolve, reject) => {
    const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    body.once("error", reject);
    res.once("finish", resolve);
    body.pipe(res);
  });
}

/** 释放或删除「closeHttp」对应资源，重复调用仍保持安全。 */
function closeHttp(server: Server): Promise<void> {
  return new Promise(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolve, reject) => {
    server.close(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(error) => (error ? reject(error) : resolve()));
  });
}

/** 释放或删除「closeWebSockets」对应资源，重复调用仍保持安全。 */
function closeWebSockets(server: WebSocketServer): Promise<void> {
  return new Promise(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolve, reject) => {
    server.close(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(error) => (error ? reject(error) : resolve()));
  });
}
