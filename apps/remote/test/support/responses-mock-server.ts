import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface ResponsesMockRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface ResponsesMockServer {
  /** Includes `/v1`, so a provider must preserve the configured API prefix. */
  baseUrl: string;
  requests: ResponsesMockRequest[];
  eventTypes: string[];
  close(): Promise<void>;
}

interface SseEvent {
  type: string;
  [key: string]: unknown;
}

const createdAt = 1_786_377_600;

const readCallA = {
  id: "fc_mock_a",
  type: "function_call",
  call_id: "call_mock_a",
  name: "read_file",
  arguments: JSON.stringify({ path: "notes/context.md" }),
  status: "completed",
} as const;

const readCallB = {
  id: "fc_mock_b",
  type: "function_call",
  call_id: "call_mock_b",
  name: "read_file",
  arguments: JSON.stringify({ path: "notes/theme.md" }),
  status: "completed",
} as const;

const firstReasoningItem = {
  id: "rs_mock_tools",
  type: "reasoning",
  summary: [{ type: "summary_text", text: "先并行读取两份沙箱资料。" }],
  status: "completed",
  encrypted_content: "ENCRYPTED_REASONING_SENTINEL_MK_20260813",
} as const;

const finalReasoningItem = {
  id: "rs_mock_final",
  type: "reasoning",
  summary: [{ type: "summary_text", text: "两个工具结果都已收到。" }],
  status: "completed",
} as const;

const finalMessageItem = {
  id: "msg_mock_final",
  type: "message",
  role: "assistant",
  content: [{
    type: "output_text",
    text: "已结合 context.md 与 theme.md 完成分析。",
    annotations: [],
    logprobs: [],
  }],
  status: "completed",
} as const;

function responseEnvelope(
  id: string,
  status: "in_progress" | "completed" | "failed",
  output: readonly unknown[],
  usage: Record<string, unknown> | null,
  error: Record<string, unknown> | null = null,
): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: createdAt,
    status,
    model: "mk-custom-responses-test",
    output,
    error,
    incomplete_details: null,
    usage,
    store: false,
  };
}

function firstRoundEvents(): SseEvent[] {
  const responseId = "resp_mock_tools";
  return [
    {
      type: "response.created",
      sequence_number: 0,
      response: responseEnvelope(responseId, "in_progress", [], null),
    },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { ...firstReasoningItem, summary: [], status: "in_progress" },
    },
    {
      type: "response.reasoning_summary_part.added",
      sequence_number: 2,
      item_id: firstReasoningItem.id,
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    },
    {
      type: "response.reasoning_summary_text.delta",
      sequence_number: 3,
      item_id: firstReasoningItem.id,
      output_index: 0,
      summary_index: 0,
      delta: "先并行读取",
    },
    {
      type: "response.reasoning_summary_text.delta",
      sequence_number: 4,
      item_id: firstReasoningItem.id,
      output_index: 0,
      summary_index: 0,
      delta: "两份沙箱资料。",
    },
    {
      type: "response.reasoning_summary_text.done",
      sequence_number: 5,
      item_id: firstReasoningItem.id,
      output_index: 0,
      summary_index: 0,
      text: "先并行读取两份沙箱资料。",
    },
    {
      type: "response.output_item.done",
      sequence_number: 6,
      output_index: 0,
      item: firstReasoningItem,
    },
    {
      type: "response.output_item.added",
      sequence_number: 7,
      output_index: 1,
      item: { ...readCallA, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      sequence_number: 8,
      item_id: readCallA.id,
      output_index: 1,
      delta: "{\"path\":\"",
    },
    {
      type: "response.output_item.added",
      sequence_number: 9,
      output_index: 2,
      item: { ...readCallB, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      sequence_number: 10,
      item_id: readCallB.id,
      output_index: 2,
      delta: "{\"path\":\"",
    },
    {
      type: "response.function_call_arguments.delta",
      sequence_number: 11,
      item_id: readCallA.id,
      output_index: 1,
      delta: "notes/context",
    },
    {
      type: "response.function_call_arguments.delta",
      sequence_number: 12,
      item_id: readCallB.id,
      output_index: 2,
      delta: "notes/theme.md\"}",
    },
    {
      type: "response.function_call_arguments.done",
      sequence_number: 13,
      item_id: readCallB.id,
      output_index: 2,
      name: readCallB.name,
      arguments: readCallB.arguments,
    },
    {
      type: "response.output_item.done",
      sequence_number: 14,
      output_index: 2,
      item: readCallB,
    },
    {
      type: "response.function_call_arguments.delta",
      sequence_number: 15,
      item_id: readCallA.id,
      output_index: 1,
      delta: ".md\"}",
    },
    {
      type: "response.function_call_arguments.done",
      sequence_number: 16,
      item_id: readCallA.id,
      output_index: 1,
      name: readCallA.name,
      arguments: readCallA.arguments,
    },
    {
      type: "response.output_item.done",
      sequence_number: 17,
      output_index: 1,
      item: readCallA,
    },
    {
      type: "response.completed",
      sequence_number: 18,
      response: responseEnvelope(
        responseId,
        "completed",
        [firstReasoningItem, readCallA, readCallB],
        {
          input_tokens: 80,
          input_tokens_details: { cached_tokens: 24 },
          output_tokens: 38,
          output_tokens_details: { reasoning_tokens: 11 },
          total_tokens: 118,
        },
      ),
    },
  ];
}

function finalRoundEvents(): SseEvent[] {
  const responseId = "resp_mock_final";
  return [
    {
      type: "response.created",
      sequence_number: 0,
      response: responseEnvelope(responseId, "in_progress", [], null),
    },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { ...finalReasoningItem, summary: [], status: "in_progress" },
    },
    {
      type: "response.reasoning_summary_text.delta",
      sequence_number: 2,
      item_id: finalReasoningItem.id,
      output_index: 0,
      summary_index: 0,
      delta: "两个工具结果都已收到。",
    },
    {
      type: "response.reasoning_summary_text.done",
      sequence_number: 3,
      item_id: finalReasoningItem.id,
      output_index: 0,
      summary_index: 0,
      text: "两个工具结果都已收到。",
    },
    {
      type: "response.output_item.done",
      sequence_number: 4,
      output_index: 0,
      item: finalReasoningItem,
    },
    {
      type: "response.output_item.added",
      sequence_number: 5,
      output_index: 1,
      item: { ...finalMessageItem, content: [], status: "in_progress" },
    },
    {
      type: "response.content_part.added",
      sequence_number: 6,
      item_id: finalMessageItem.id,
      output_index: 1,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [], logprobs: [] },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 7,
      item_id: finalMessageItem.id,
      output_index: 1,
      content_index: 0,
      delta: "已结合 context.md ",
      logprobs: [],
    },
    {
      type: "response.output_text.delta",
      sequence_number: 8,
      item_id: finalMessageItem.id,
      output_index: 1,
      content_index: 0,
      delta: "与 theme.md 完成分析。",
      logprobs: [],
    },
    {
      type: "response.output_text.done",
      sequence_number: 9,
      item_id: finalMessageItem.id,
      output_index: 1,
      content_index: 0,
      text: "已结合 context.md 与 theme.md 完成分析。",
      logprobs: [],
    },
    {
      type: "response.content_part.done",
      sequence_number: 10,
      item_id: finalMessageItem.id,
      output_index: 1,
      content_index: 0,
      part: finalMessageItem.content[0],
    },
    {
      type: "response.output_item.done",
      sequence_number: 11,
      output_index: 1,
      item: finalMessageItem,
    },
    {
      type: "response.completed",
      sequence_number: 12,
      response: responseEnvelope(
        responseId,
        "completed",
        [finalReasoningItem, finalMessageItem],
        {
          input_tokens: 142,
          input_tokens_details: { cached_tokens: 80 },
          output_tokens: 48,
          output_tokens_details: { reasoning_tokens: 9 },
          total_tokens: 190,
        },
      ),
    },
  ];
}

function failedEvents(): SseEvent[] {
  const responseId = "resp_mock_failed";
  return [
    {
      type: "response.created",
      sequence_number: 0,
      response: responseEnvelope(responseId, "in_progress", [], null),
    },
    {
      type: "response.failed",
      sequence_number: 1,
      response: responseEnvelope(
        responseId,
        "failed",
        [],
        null,
        { code: "server_error", message: "MK mock Responses upstream failed." },
      ),
    },
  ];
}

function normalizeHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) {
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return headers;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) {
    return {};
  }

  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Responses mock expects a JSON object request body.");
  }
  return parsed as Record<string, unknown>;
}

function isFailureScenario(body: Record<string, unknown>): boolean {
  const metadata = body.metadata;
  return typeof metadata === "object"
    && metadata !== null
    && !Array.isArray(metadata)
    && (metadata as Record<string, unknown>).mk_mock_scenario === "failed";
}

function containsFunctionCallOutput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsFunctionCallOutput);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (record.type === "function_call_output") {
    return true;
  }
  return Object.values(record).some(containsFunctionCallOutput);
}

function validContinuation(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const reasoningIndex = value.findIndex((item) => isRecord(item)
    && item.type === "reasoning"
    && item.encrypted_content === firstReasoningItem.encrypted_content);
  const callAIndex = value.findIndex((item) => isRecord(item)
    && item.type === "function_call" && item.call_id === readCallA.call_id);
  const callBIndex = value.findIndex((item) => isRecord(item)
    && item.type === "function_call" && item.call_id === readCallB.call_id);
  const outputAIndex = value.findIndex((item) => isRecord(item)
    && item.type === "function_call_output" && item.call_id === readCallA.call_id);
  const outputBIndex = value.findIndex((item) => isRecord(item)
    && item.type === "function_call_output" && item.call_id === readCallB.call_id);
  return reasoningIndex >= 0
    && reasoningIndex < callAIndex
    && callAIndex < callBIndex
    && callBIndex < outputAIndex
    && outputAIndex < outputBIndex;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function waitForNextWrite(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function writeFragmented(res: ServerResponse, value: string): Promise<void> {
  // Split every frame itself, rather than only splitting between frames. This
  // forces clients to handle an SSE record spanning multiple HTTP/TCP writes.
  const splitAt = Math.max(1, Math.floor(value.length / 2));
  res.write(value.slice(0, splitAt), "utf8");
  await waitForNextWrite();
  res.write(value.slice(splitAt), "utf8");
  await waitForNextWrite();
}

async function writeEventStream(
  res: ServerResponse,
  events: readonly SseEvent[],
  eventTypes: string[],
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();

  let index = 0;
  for (const event of events) {
    eventTypes.push(event.type);
    await writeFragmented(
      res,
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    );

    if (index === 0) {
      await writeFragmented(res, ": mk-responses-heartbeat\n\n");
    }
    index += 1;
  }
  res.end();
}

export async function startResponsesMockServer(): Promise<ResponsesMockServer> {
  const requests: ResponsesMockRequest[] = [];
  const eventTypes: string[] = [];

  const server = createServer((request, response) => {
    void (async () => {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({
          error: {
            code: "invalid_json",
            message: error instanceof Error ? error.message : "Invalid JSON request body.",
          },
        }));
        return;
      }

      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: normalizeHeaders(request),
        body,
      });

      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (request.method !== "POST" || pathname !== "/v1/responses") {
        response.writeHead(request.method === "POST" ? 404 : 405, {
          "content-type": "application/json; charset=utf-8",
        });
        response.end(JSON.stringify({ error: { code: "not_found" } }));
        return;
      }

      // Routing is derived only from the current request. No response ID or
      // server-side conversation state is retained: callers must send store:false
      // and include function_call_output items in the second request.
      const events = isFailureScenario(body)
        ? failedEvents()
        : containsFunctionCallOutput(body.input)
          ? validContinuation(body.input)
            ? finalRoundEvents()
            : failedEvents()
          : firstRoundEvents();
      await writeEventStream(response, events, eventTypes);
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({
          error: {
            code: "mock_server_error",
            message: error instanceof Error ? error.message : "Unknown mock server error.",
          },
        }));
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    eventTypes,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        server.closeIdleConnections();
      });
    },
  };
}
