import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  isTurnTraceDocument,
  type TurnEvaluationRecord,
} from "@kindergarten/evaluation-contract";
import { evaluateTurn } from "./evaluator.js";
import type { EvaluationRepository } from "./repository.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export class EvaluationServer {
  readonly http: Server;

  constructor(private readonly repository: EvaluationRepository) {
    this.http = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        console.error("Evaluation API 处理失败", error);
        json(response, 500, { error: errorText(error) });
      });
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
    await new Promise<void>((resolve, reject) => {
      this.http.close((error) => error ? reject(error) : resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    cors(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { ok: true, service: "kindergarten-evaluation" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/turn-evaluations") {
      const value = await readJson(request);
      if (!isTurnTraceDocument(value)) {
        json(response, 400, { error: "Turn Trace 文档格式无效" });
        return;
      }
      const record: TurnEvaluationRecord = {
        schemaVersion: 1,
        trace: structuredClone(value),
        result: evaluateTurn(value),
        createdAt: new Date().toISOString(),
      };
      await this.repository.put(record);
      json(response, 201, record);
      return;
    }

    const match = url.pathname.match(/^\/api\/v1\/turn-evaluations\/([^/]+)\/([^/]+)$/);
    if (request.method === "GET" && match?.[1] && match[2]) {
      const record = await this.repository.get(
        decodeURIComponent(match[1]),
        decodeURIComponent(match[2]),
      );
      if (!record) {
        json(response, 404, { error: "尚未生成本轮评测" });
        return;
      }
      json(response, 200, record);
      return;
    }
    json(response, 404, { error: "Not Found" });
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求体超过 4 MiB");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("请求体不是有效 JSON");
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function cors(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
