import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface ChatCompletionsMockRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface ChatCompletionsMockServer {
  baseUrl: string;
  requests: ChatCompletionsMockRequest[];
  close(): Promise<void>;
}

export interface ChatCompletionsMockOptions {
  thinking?: "toggle" | "ignored" | "rejected";
  tools?: boolean;
  omitDone?: boolean;
}

export async function startChatCompletionsMockServer(
  options: ChatCompletionsMockOptions = {},
): Promise<ChatCompletionsMockServer> {
  const requests: ChatCompletionsMockRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response, requests, options);
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
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
    }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: ChatCompletionsMockRequest[],
  options: ChatCompletionsMockOptions,
): Promise<void> {
  const body = await readJsonBody(request);
  requests.push({
    method: request.method ?? "",
    url: request.url ?? "",
    headers: Object.fromEntries(Object.entries(request.headers).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : [],
    )),
    body,
  });
  if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
    response.statusCode = 404;
    response.end("not found");
    return;
  }
  if (request.headers.authorization !== "Bearer test-token") {
    response.statusCode = 401;
    response.end(JSON.stringify({ error: { message: "missing bearer" } }));
    return;
  }
  if (body.model === "http-error") {
    response.statusCode = 400;
    response.end(JSON.stringify({
      error: {
        message: "rejected test-token",
        api_key: "reflected-api-key",
        nested: { password: "reflected-password", safe: "visible-detail" },
      },
    }));
    return;
  }
  if (body.model === "sse-error") {
    openSse(response);
    writeEvent(response, {
      error: {
        code: "bad_request",
        message: "token=test-token api_key=reflected-key password=reflected-password",
      },
    });
    response.end("data: [DONE]\n\n");
    return;
  }
  if (body.model === "oversized-line") {
    openSse(response);
    response.end(`data: ${"x".repeat(1024 * 1024 + 32)}\n\n`);
    return;
  }
  if (options.thinking === "rejected" && "enable_thinking" in body) {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: { message: "unknown field enable_thinking" } }));
    return;
  }

  openSse(response);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const hasToolResult = messages.some((item) =>
    isRecord(item) && item.role === "tool",
  );
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (hasToolResult) {
    writeTextStream(response, body, options, "MK_TOOL_CONTINUATION_OK");
  } else if (tools.length > 0 && options.tools !== false) {
    const names = tools.flatMap((tool) => {
      const fn = isRecord(tool) ? recordValue(tool.function) : undefined;
      return typeof fn?.name === "string" ? [fn.name] : [];
    });
    if (names.includes("mk_capability_probe")) {
      writeProbeToolStream(response, body);
    } else {
      writeInterleavedToolStream(response, body);
    }
  } else {
    writeTextStream(response, body, options, "MK_TEXT_OK");
  }
  if (!options.omitDone) response.write("data: [DONE]\n\n");
  response.end();
}

function writeTextStream(
  response: ServerResponse,
  body: Record<string, unknown>,
  options: ChatCompletionsMockOptions,
  text: string,
): void {
  const thinking = body.enable_thinking === true && options.thinking === "toggle";
  if (thinking) {
    writeEvent(response, chatChunk({ reasoning_content: "先计算，" }));
    writeEvent(response, chatChunk({ reasoning_content: "再作答。" }));
  }
  writeEvent(response, chatChunk({ content: text.slice(0, 4) }));
  writeEvent(response, chatChunk({ content: text.slice(4) }));
  writeEvent(response, {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  if (requestsUsage(body)) writeEvent(response, usageChunk());
}

function writeProbeToolStream(
  response: ServerResponse,
  body: Record<string, unknown>,
): void {
  writeEvent(response, chatChunk({
    tool_calls: [{
      index: 0,
      id: "call_probe",
      type: "function",
      function: { name: "mk_capability_", arguments: "{\"nonce\":\"mk-" },
    }],
  }));
  writeEvent(response, chatChunk({
    tool_calls: [{
      index: 0,
      function: { name: "probe", arguments: "siliconflow-probe-nonce\"}" },
    }],
  }));
  writeFinishAndUsage(response, body, "tool_calls");
}

function writeInterleavedToolStream(
  response: ServerResponse,
  body: Record<string, unknown>,
): void {
  writeEvent(response, chatChunk({
    tool_calls: [{
      index: 0,
      id: "call_a",
      type: "function",
      function: { name: "read_", arguments: "{\"path\":\"notes/" },
    }],
  }));
  writeEvent(response, chatChunk({
    tool_calls: [{
      index: 1,
      id: "call_b",
      type: "function",
      function: { name: "write_file", arguments: "{\"path\":\"notes/b.md\",\"content\":\"B\"}" },
    }],
  }));
  // B is already complete while A continues; output order must still be 0 then 1.
  writeEvent(response, chatChunk({
    tool_calls: [{
      index: 0,
      function: { name: "file", arguments: "a.md\"}" },
    }],
  }));
  writeFinishAndUsage(response, body, "tool_calls");
}

function writeFinishAndUsage(
  response: ServerResponse,
  body: Record<string, unknown>,
  finishReason: string,
): void {
  writeEvent(response, {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });
  if (requestsUsage(body)) writeEvent(response, usageChunk());
}

function chatChunk(delta: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}

function usageChunk(): Record<string, unknown> {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    choices: [],
    usage: {
      prompt_tokens: 41,
      completion_tokens: 17,
      total_tokens: 58,
      prompt_tokens_details: { cached_tokens: 9 },
      completion_tokens_details: { reasoning_tokens: 5 },
    },
  };
}

function requestsUsage(body: Record<string, unknown>): boolean {
  const streamOptions = recordValue(body.stream_options);
  return streamOptions?.include_usage === true;
}

function openSse(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream");
}

function writeEvent(response: ServerResponse, value: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("request body must be an object");
  return parsed;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
