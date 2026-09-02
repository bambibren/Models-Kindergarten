import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** 构造「ChatCompletionsMockRequest」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
export interface ChatCompletionsMockRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** 构造「ChatCompletionsMockServer」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
export interface ChatCompletionsMockServer {
  baseUrl: string;
  requests: ChatCompletionsMockRequest[];
  close(): Promise<void>;
}

/** 构造「ChatCompletionsMockOptions」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
export interface ChatCompletionsMockOptions {
  thinking?: "toggle" | "ignored" | "rejected";
  tools?: boolean;
  omitDone?: boolean;
  longToolContentBytes?: number;
}

/** 构造「startChatCompletionsMockServer」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
export async function startChatCompletionsMockServer(
  options: ChatCompletionsMockOptions = {},
): Promise<ChatCompletionsMockServer> {
  const requests: ChatCompletionsMockRequest[] = [];
  const server = createServer(/** 构造「server」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async (request, response) => {
    try {
      await handleRequest(request, response, requests, options);
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: /** 构造「close」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => new Promise<void>(/** 构造「close」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(resolve, reject) => {
      server.close(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(error) => error ? reject(error) : resolve());
    }),
  };
}

/** 构造「handleRequest」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
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
    headers: Object.fromEntries(Object.entries(request.headers).flatMap(/** 构造「headers」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
([key, value]) =>
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
  const hasToolResult = messages.some(/** 构造「hasToolResult」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) =>
    isRecord(item) && item.role === "tool",
  );
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (hasToolResult) {
    writeTextStream(response, body, options, "MK_TOOL_CONTINUATION_OK");
  } else if (tools.length > 0 && options.tools !== false) {
    const names = tools.flatMap(/** 构造「names」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(tool) => {
      const fn = isRecord(tool) ? recordValue(tool.function) : undefined;
      return typeof fn?.name === "string" ? [fn.name] : [];
    });
    if (options.longToolContentBytes) {
      writeLongToolStream(response, body, options.longToolContentBytes);
    } else if (names.includes("mk_capability_probe")) {
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

/** 模拟 reasoning/说明文字之后长时间生成 write_file 参数的真实故障形态。 */
function writeLongToolStream(response: ServerResponse, body: Record<string, unknown>, bytes: number): void {
  writeEvent(response, chatChunk({ reasoning_content: "先规划页面。" }));
  writeEvent(response, chatChunk({ content: "开始编写网站。" }));
  const args = JSON.stringify({ path: "index.html", content: "x".repeat(bytes) });
  const parts = args.match(/.{1,1024}/gs) ?? [];
  for (const [index, part] of parts.entries()) {
    writeEvent(response, chatChunk({
      tool_calls: [{
        index: 0,
        ...(index === 0 ? { id: "call_long_html", type: "function" } : {}),
        function: { ...(index === 0 ? { name: "write_file" } : {}), arguments: part },
      }],
    }));
  }
  writeFinishAndUsage(response, body, "tool_calls");
}

/** 构造「writeTextStream」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
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

/** 构造「writeProbeToolStream」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
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

/** 构造「writeInterleavedToolStream」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
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
  // B 先完成而 A 仍在增量生成；最终输出顺序仍必须保持 0、1。
  writeEvent(response, chatChunk({
    tool_calls: [{
      index: 0,
      function: { name: "file", arguments: "a.md\"}" },
    }],
  }));
  writeFinishAndUsage(response, body, "tool_calls");
}

/** 构造「writeFinishAndUsage」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
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

/** 构造「chatChunk」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function chatChunk(delta: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}

/** 构造「usageChunk」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
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

/** 构造「requestsUsage」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function requestsUsage(body: Record<string, unknown>): boolean {
  const streamOptions = recordValue(body.stream_options);
  return streamOptions?.include_usage === true;
}

/** 构造「openSse」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function openSse(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream");
}

/** 构造「writeEvent」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function writeEvent(response: ServerResponse, value: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

/** 构造「readJsonBody」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("request body must be an object");
  return parsed;
}

/** 构造「recordValue」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** 构造「isRecord」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
