import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInput, ModelStudent } from "../src/model/model-provider.js";
import { OllamaProvider } from "../src/model/ollama-provider.js";

const student: ModelStudent = {
  id: "ollama-test",
  name: "Ollama Test",
  provider: {
    kind: "ollama",
    model: "qwen3:8b",
    baseUrl: "http://127.0.0.1:11434",
  },
  agentConfig: {
    systemPrompt: "你是测试助手。",
    temperature: 0.2,
  },
};

const input: ModelInput = {
  messages: [
    { role: "user", content: "读取 a.txt" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ name: "read_file", arguments: { path: "a.txt" } }],
    },
    { role: "tool", content: "文件内容", toolName: "read_file", toolCallId: "call-1" },
  ],
  tools: [{
    type: "function",
    function: {
      name: "read_file",
      description: "读取文件",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Ollama Provider 上下文序列化", () => {
  it("按 Ollama Chat API 的实际字段序列化 system、tools 和 messages", () => {
    const provider = new OllamaProvider(student);

    expect(JSON.parse(provider.serializeContext({
      kind: "system",
      content: student.agentConfig.systemPrompt,
    }).value)).toEqual({ role: "system", content: "你是测试助手。" });

    expect(JSON.parse(provider.serializeContext({
      kind: "tools",
      tools: input.tools,
    }).value)).toEqual(input.tools);

    expect(JSON.parse(provider.serializeContext({
      kind: "messages",
      messages: input.messages,
    }).value)).toEqual([
      { role: "user", content: "读取 a.txt" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "read_file", arguments: { path: "a.txt" } } }],
      },
      { role: "tool", content: "文件内容", tool_name: "read_file" },
    ]);
  });

  it("展示快照与发送给 Ollama 的请求使用同一份转换结果", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response([
        JSON.stringify({ message: { content: "完成" }, done: false }),
        JSON.stringify({ message: { content: "" }, done: true }),
        "",
      ].join("\n"), { status: 200 });
    }));
    const provider = new OllamaProvider(student);

    for await (const _event of provider.stream(input, new AbortController().signal)) {
      // 消费完整流，确保请求构造与解析都经过真实路径。
    }

    expect(body?.messages).toEqual([
      JSON.parse(provider.serializeContext({
        kind: "system",
        content: student.agentConfig.systemPrompt,
      }).value),
      ...JSON.parse(provider.serializeContext({
        kind: "messages",
        messages: input.messages,
      }).value),
    ]);
    expect(body?.tools).toEqual(JSON.parse(provider.serializeContext({
      kind: "tools",
      tools: input.tools,
    }).value));
  });

  it("明确标记被裁剪来源没有进入当前模型请求", () => {
    const provider = new OllamaProvider(student);
    expect(JSON.parse(provider.serializeContext({
      kind: "omitted",
      sourceIds: ["message-old"],
    }).value)).toEqual({ sent: false, sourceIds: ["message-old"] });
  });
});
