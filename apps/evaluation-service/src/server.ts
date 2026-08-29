import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { TurnEvaluationRecord } from "@kindergarten/evaluation-contract";
import { evaluateTurn } from "./evaluator.js";
import type { EvaluationRepository } from "./repository.js";
import { normalizeTurnTrace } from "./trace-migration.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** 描述「EvaluationServer」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class EvaluationServer {
  readonly http: Server;

  /** 初始化「EvaluationServer」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly repository: EvaluationRepository) {
    this.http = createServer(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(request, response) => {
      void this.handle(request, response).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(error: unknown) => {
        console.error("Evaluation API 处理失败", error);
        json(response, 500, { error: errorText(error) });
      });
    });
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
    await new Promise<void>(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolve, reject) => {
      this.http.close(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(error) => error ? reject(error) : resolve());
    });
  }

  /** 处理「handle」事件，校验归属后再推进状态且避免重复提交。 */
private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    cors(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/health/live")) {
      json(response, 200, { ok: true, service: "kindergarten-evaluation" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/health/ready") {
      json(response, this.repository.ready ? 200 : 503, {
        ok: this.repository.ready,
        service: "kindergarten-evaluation",
        checks: { repository: this.repository.ready },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/turn-evaluations") {
      const value = await readJson(request);
      let trace: TurnEvaluationRecord["trace"];
      try {
        trace = normalizeTurnTrace(value);
      } catch {
        json(response, 400, { error: "Turn Trace 文档格式无效" });
        return;
      }
      const record: TurnEvaluationRecord = {
        schemaVersion: 2,
        trace,
        result: evaluateTurn(trace),
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

/** 读取「readJson」所需数据，并遵守作用域、分页与容量边界。 */
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

/** 执行「json」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

/** 执行「cors」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function cors(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}

/** 把未知异常转换为「errorText」文本，避免错误序列化过程再次抛出。 */
function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
