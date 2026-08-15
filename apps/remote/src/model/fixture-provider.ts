import type {
  ConcreteReasoningProfile,
  ModelReasoningCapability,
} from "@kindergarten/contracts";
import type {
  ModelContextFragment,
  ModelContextSerialization,
  ModelEvent,
  ModelInput,
  ModelProvider,
  ModelStudent,
} from "./model-provider.js";

/** 确定性 Provider 只供自动测试，不是产品的本地模型模式。 */
export class FixtureProvider implements ModelProvider {
  readonly reasoningCapability: ModelReasoningCapability = {
    schemaVersion: 1,
    control: "fixed",
    adjustable: false,
    supportedProfiles: ["balanced"],
    defaultProfile: "balanced",
  };
  readonly student: ModelStudent = {
    id: "fixture-student",
    name: "Fixture Student",
    sizeClass: "large",
    provider: {
      kind: "ollama",
      model: "fixture",
      baseUrl: "http://127.0.0.1",
    },
    generationDefaults: { reasoningProfile: "balanced" },
  };

  nativeReasoning(profile: ConcreteReasoningProfile): Record<string, never> {
    if (profile !== "balanced") throw new Error(`Fixture 不支持推理档位: ${profile}`);
    return {};
  }

  serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    return serializeFixtureContext(this.student, fragment);
  }

  serializeInput(input: ModelInput): ModelContextSerialization {
    return {
      provider: this.student.provider.kind,
      model: this.student.provider.model,
      format: "json",
      value: JSON.stringify(input, null, 2),
    };
  }

  async *stream(input: ModelInput, signal: AbortSignal): AsyncIterable<ModelEvent> {
    if (input.systemPrompt?.includes("人工评测题目整理器")) {
      const payload = fixtureWorksheet(input.messages.at(-1)?.content ?? "");
      yield { type: "text_delta", text: JSON.stringify(payload) };
      yield { type: "finish", reason: "stop" };
      return;
    }
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

function fixtureWorksheet(prompt: string) {
  const marker = "输入：\n";
  const value = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as {
    task: string;
    lanes: Array<{ variantId: string; answerUnits: unknown[] }>;
  };
  return {
    requirements: [{ label: value.task.slice(0, 120), weight: 1 }],
    workflows: value.lanes.map((lane) => ({ variantId: lane.variantId, steps: ["理解任务并形成回答"] })),
    outputSections: value.lanes.map((lane) => ({
      variantId: lane.variantId,
      sections: [{ label: "完整回答", startUnit: 0, endUnit: lane.answerUnits.length }],
    })),
  };
}

function serializeFixtureContext(
  student: ModelStudent,
  fragment: ModelContextFragment,
): ModelContextSerialization {
  const value = fragment.kind === "system"
    ? { role: "system", content: fragment.content }
    : fragment.kind === "tools"
      ? fragment.tools
      : fragment.kind === "messages"
        ? fragment.messages
        : { sent: false, sourceIds: fragment.sourceIds };
  return {
    provider: student.provider.kind,
    model: student.provider.model,
    format: "json",
    value: JSON.stringify(value, null, 2),
  };
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
