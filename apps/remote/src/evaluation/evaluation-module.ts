import type {
  TurnEvaluationRecord,
  TurnTraceDocument,
} from "@kindergarten/evaluation-contract";
import type {
  RuntimeObservationEvent,
  RuntimeObservationSink,
} from "@kindergarten/runtime-observation";
import { evaluateTurn } from "./evaluator.js";
import { EvaluationRepository } from "./repository.js";
import { TraceCollector } from "./trace-collector.js";
import { normalizeTurnTrace } from "./trace-migration.js";

const PUBLIC_PREFIX = "/api/evaluation/v1";

/** Experiment 只依赖读取、排空和短期 Trace，不依赖 Evaluation 的具体存储实现。 */
export interface EvaluationAccess {
  get(
    sessionId: string,
    turnId: string,
  ): Promise<Pick<TurnEvaluationRecord, "result"> | undefined>;
  flush(): Promise<void>;
  takeTrace(sessionId: string, turnId: string): TurnTraceDocument | undefined;
}

/**
 * Evaluation 的进程内模块边界：接收 Runtime 观察、异步评分持久化并提供只读查询。
 * 模块不可用时 Agent 仍可运行，只有评测读取和 Experiment 指标降级。
 */
export class EvaluationModule implements RuntimeObservationSink, EvaluationAccess {
  private readonly repository: EvaluationRepository;
  private readonly collector: TraceCollector;
  private initialized = false;
  private initializationError: string | undefined;

  constructor(dataDir: string) {
    this.repository = new EvaluationRepository(dataDir);
    this.collector = new TraceCollector(async (document) => {
      if (!this.initialized) throw new Error(this.initializationError ?? "Evaluation 尚未初始化");
      const trace = normalizeTurnTrace(document);
      await this.repository.put({
        schemaVersion: 2,
        trace,
        result: evaluateTurn(trace),
        createdAt: new Date().toISOString(),
      });
    });
  }

  /** 初始化失败只把 Evaluation 标为不可用，不阻止 Remote 主链启动。 */
  async initialize(): Promise<void> {
    try {
      await this.repository.initialize();
      this.initialized = true;
      this.initializationError = undefined;
    } catch (error) {
      this.initialized = false;
      this.initializationError = errorText(error);
      console.warn(`Evaluation 初始化失败，评测能力已降级：${this.initializationError}`);
    }
  }

  get available(): boolean {
    return this.initialized && this.repository.ready;
  }

  emit(event: RuntimeObservationEvent): void {
    this.collector.emit(event);
  }

  async flush(): Promise<void> {
    await this.collector.flush();
  }

  takeTrace(sessionId: string, turnId: string): TurnTraceDocument | undefined {
    return this.collector.takeTrace(sessionId, turnId);
  }

  async get(sessionId: string, turnId: string): Promise<TurnEvaluationRecord | undefined> {
    if (!this.available) return undefined;
    return this.repository.get(sessionId, turnId);
  }

  /** 浏览器沿用同源只读路径；评测写入只允许由 Runtime 观察链触发。 */
  async fetch(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname !== PUBLIC_PREFIX && !url.pathname.startsWith(`${PUBLIC_PREFIX}/`)) {
      return undefined;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json({ error: "Evaluation 浏览器入口只允许读取" }, { status: 405 });
    }
    if (!this.available) {
      return Response.json({ error: "Evaluation 模块暂不可用" }, { status: 503 });
    }

    const match = url.pathname.match(
      /^\/api\/evaluation\/v1\/turn-evaluations\/([^/]+)\/([^/]+)$/,
    );
    if (!match?.[1] || !match[2]) return Response.json({ error: "Not Found" }, { status: 404 });
    const record = await this.repository.get(
      decodeURIComponent(match[1]),
      decodeURIComponent(match[2]),
    );
    if (!record) return Response.json({ error: "尚未生成本轮评测" }, { status: 404 });
    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return Response.json(record);
  }
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
