import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface CapabilityMockRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface ResponsesCapabilityMockOptions {
  supportedEfforts: readonly string[];
  model?: string;
  thought?: boolean;
  usage?: boolean;
  toolLoop?: boolean;
  effectiveEffort?: (requested: string | undefined) => string | undefined;
}

export interface ResponsesCapabilityMockServer {
  baseUrl: string;
  requests: CapabilityMockRequest[];
  close(): Promise<void>;
}

const functionCall = {
  id: "fc_capability_probe",
  type: "function_call",
  call_id: "call_capability_probe",
  name: "mk_capability_probe",
  arguments: JSON.stringify({ nonce: "mk-probe-nonce" }),
  status: "completed",
} as const;

const reasoningItem = {
  id: "rs_capability_probe",
  type: "reasoning",
  summary: [{ type: "summary_text", text: "验证兼容能力。" }],
  encrypted_content: "CAPABILITY_PROBE_OPAQUE_REASONING",
  status: "completed",
} as const;

export async function startResponsesCapabilityMockServer(
  options: ResponsesCapabilityMockOptions,
): Promise<ResponsesCapabilityMockServer> {
  const requests: CapabilityMockRequest[] = [];
  const server = createServer((request, response) => {
    void handle(request, response, options, requests).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "mock_failure", message: String(error) } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }),
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: ResponsesCapabilityMockOptions,
  requests: CapabilityMockRequest[],
): Promise<void> {
  const body = await readBody(request);
  requests.push({
    method: request.method ?? "",
    url: request.url ?? "",
    headers: headers(request),
    body,
  });
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method !== "POST" || pathname !== "/v1/responses") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "not_found" } }));
    return;
  }

  const requestedEffort = effort(body);
  if (requestedEffort && !options.supportedEfforts.includes(requestedEffort)) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: {
        code: "unsupported_value",
        param: "reasoning.effort",
        message: `Unsupported reasoning effort: ${requestedEffort}`,
      },
    }));
    return;
  }

  const effectiveEffort = options.effectiveEffort?.(requestedEffort) ?? requestedEffort;
  const input = body.input;
  if (containsType(input, "function_call_output")) {
    if (options.toolLoop === false || !containsType(input, "function_call")) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "invalid_tool_continuation" } }));
      return;
    }
    streamEvents(response, finalTextEvents(options, effectiveEffort));
    return;
  }

  if (forcedProbeTool(body)) {
    if (options.toolLoop === false) {
      streamEvents(response, textEvents(options, effectiveEffort));
      return;
    }
    streamEvents(response, toolEvents(options, effectiveEffort));
    return;
  }

  streamEvents(response, textEvents(options, effectiveEffort));
}

function textEvents(
  options: ResponsesCapabilityMockOptions,
  effectiveEffort: string | undefined,
): Array<Record<string, unknown>> {
  const output = [{
    id: "msg_capability_text",
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "MK_TEXT_OK", annotations: [] }],
    status: "completed",
  }];
  return [
    createdEvent(options, effectiveEffort),
    ...thoughtEvents(options),
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "MK_TEXT_OK" },
    completedEvent(options, effectiveEffort, output),
  ];
}

function toolEvents(
  options: ResponsesCapabilityMockOptions,
  effectiveEffort: string | undefined,
): Array<Record<string, unknown>> {
  const output = [...(options.thought === false ? [] : [reasoningItem]), functionCall];
  const outputIndex = output.length - 1;
  return [
    createdEvent(options, effectiveEffort),
    ...thoughtEvents(options),
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...functionCall, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: functionCall.id,
      output_index: outputIndex,
      delta: "{\"nonce\":\"mk-",
    },
    {
      type: "response.function_call_arguments.done",
      item_id: functionCall.id,
      output_index: outputIndex,
      name: functionCall.name,
      arguments: functionCall.arguments,
    },
    { type: "response.output_item.done", output_index: outputIndex, item: functionCall },
    completedEvent(options, effectiveEffort, output),
  ];
}

function finalTextEvents(
  options: ResponsesCapabilityMockOptions,
  effectiveEffort: string | undefined,
): Array<Record<string, unknown>> {
  const output = [{
    id: "msg_capability_final",
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "MK_TOOL_OK", annotations: [] }],
    status: "completed",
  }];
  return [
    createdEvent(options, effectiveEffort),
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "MK_TOOL_OK" },
    completedEvent(options, effectiveEffort, output),
  ];
}

function createdEvent(
  options: ResponsesCapabilityMockOptions,
  effectiveEffort: string | undefined,
): Record<string, unknown> {
  return {
    type: "response.created",
    response: envelope("in_progress", options, effectiveEffort, []),
  };
}

function completedEvent(
  options: ResponsesCapabilityMockOptions,
  effectiveEffort: string | undefined,
  output: readonly unknown[],
): Record<string, unknown> {
  return {
    type: "response.completed",
    response: envelope("completed", options, effectiveEffort, output),
  };
}

function envelope(
  status: "in_progress" | "completed",
  options: ResponsesCapabilityMockOptions,
  effectiveEffort: string | undefined,
  output: readonly unknown[],
): Record<string, unknown> {
  return {
    id: `resp_capability_${status}`,
    object: "response",
    status,
    model: options.model ?? "gpt-5.5",
    output,
    store: false,
    ...(effectiveEffort ? { reasoning_effort: effectiveEffort } : {}),
    usage: options.usage === false ? null : {
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: options.thought === false ? 0 : 2 },
      total_tokens: 19,
    },
  };
}

function thoughtEvents(options: ResponsesCapabilityMockOptions): Array<Record<string, unknown>> {
  if (options.thought === false) return [];
  return [{
    type: "response.reasoning_summary_text.delta",
    item_id: reasoningItem.id,
    output_index: 0,
    summary_index: 0,
    delta: "验证兼容能力。",
  }];
}

function streamEvents(response: ServerResponse, events: readonly Record<string, unknown>[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
  });
  for (const event of events) {
    response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

function forcedProbeTool(body: Record<string, unknown>): boolean {
  const choice = record(body.tool_choice);
  return choice?.type === "function" && choice.name === "mk_capability_probe";
}

function effort(body: Record<string, unknown>): string | undefined {
  const reasoning = record(body.reasoning);
  return typeof reasoning?.effort === "string" ? reasoning.effort : undefined;
}

function containsType(value: unknown, type: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsType(item, type));
  const item = record(value);
  return item ? item.type === type || Object.values(item).some((child) => containsType(child, type)) : false;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const result = record(value);
  if (!result) throw new Error("request body must be an object");
  return result;
}

function headers(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(Object.entries(request.headers).flatMap(([key, value]) => {
    if (value === undefined) return [];
    return [[key, Array.isArray(value) ? value.join(", ") : value]];
  }));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
