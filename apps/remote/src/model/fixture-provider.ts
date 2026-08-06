import type {
  ModelEvent,
  ModelInput,
  ModelProvider,
  ModelStudent,
} from "./model-provider.js";

/** 确定性 Provider 只供自动测试，不是产品的本地模型模式。 */
export class FixtureProvider implements ModelProvider {
  readonly student: ModelStudent = {
    id: "fixture-student",
    name: "Fixture Student",
    provider: {
      kind: "ollama",
      model: "fixture",
      baseUrl: "http://127.0.0.1",
    },
    agentConfig: { systemPrompt: "fixture" },
  };

  async *stream(input: ModelInput, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const turns = input.messages.filter((item) => item.role === "user").length;
    const reply = [
      "我是运行在 Remote 进程里的 Kindergarten Agent。",
      `这是当前会话的第 ${turns} 轮输入。`,
      "Web、ACP、Agent 和模型正在走同一条真实链路。",
    ];

    for (const part of reply) {
      await wait(5, signal);
      yield { type: "text_delta", text: `${part}\n` };
    }
    yield { type: "finish", reason: "stop" };
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", cancel, { once: true });
    function done(): void {
      signal.removeEventListener("abort", cancel);
      resolve();
    }
    function cancel(): void {
      clearTimeout(timer);
      reject(abortError());
    }
  });
}

function abortError(): Error {
  return new DOMException("模型生成已取消", "AbortError");
}
