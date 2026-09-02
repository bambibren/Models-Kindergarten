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

  /** 执行「nativeReasoning」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
nativeReasoning(profile: ConcreteReasoningProfile): Record<string, never> {
    if (profile !== "balanced") throw new Error(`Fixture 不支持推理档位: ${profile}`);
    return {};
  }

  /** 执行「serializeContext」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    return serializeFixtureContext(this.student, fragment);
  }

  /** 执行「serializeInput」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
serializeInput(input: ModelInput): ModelContextSerialization {
    return {
      provider: this.student.provider.kind,
      model: this.student.provider.model,
      format: "json",
      value: JSON.stringify(input, null, 2),
    };
  }

  /** 执行「stream」主流程，传播取消与失败并在结束时清理临时资源。 */
async *stream(
    input: ModelInput,
    signal: AbortSignal,
    onActivity?: () => void,
  ): AsyncIterable<ModelEvent> {
    if (input.systemPrompt?.includes("人工评测材料整理器")) {
      const payload = fixtureWorksheet(input.messages.at(-1)?.content ?? "");
      const itemId = "fixture:message:0";
      onActivity?.();
      yield { type: "output_item_started", item: { id: itemId, kind: "message" } };
      const text = JSON.stringify(payload);
      yield { type: "output_item_delta", itemId, delta: { kind: "text", text } };
      yield { type: "output_item_completed", item: { id: itemId, kind: "message", text } };
      onActivity?.();
      yield { type: "finish", reason: "stop" };
      return;
    }
    const turns = input.messages.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.role === "user").length;
    const reply = [
      "我是运行在 Remote 进程里的 Kindergarten Agent。",
      `这是当前会话的第 ${turns} 轮输入。`,
      "Web、ACP、Agent 和模型正在走同一条真实链路。",
    ];

    const itemId = "fixture:message:0";
    let text = "";
    yield { type: "output_item_started", item: { id: itemId, kind: "message" } };
    for (const part of reply) {
      await wait(5, signal);
      onActivity?.();
      const delta = `${part}\n`;
      text += delta;
      yield { type: "output_item_delta", itemId, delta: { kind: "text", text: delta } };
    }
    yield { type: "output_item_completed", item: { id: itemId, kind: "message", text } };
    onActivity?.();
    yield { type: "finish", reason: "stop" };
  }
}

/** 执行「fixtureWorksheet」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function fixtureWorksheet(prompt: string) {
  const marker = "输入：\n";
  const value = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as {
    task?: string;
    lanes: Array<{ variantId: string; firstThought?: string; answerUnits?: unknown[] }>;
  };
  if (value.task !== undefined) {
    return {
      requirements: [{
        label: value.task.slice(0, 120),
        weight: 1,
        sourceVariantIds: ["task"],
        matchedVariantIds: value.lanes.flatMap(/** Fixture 只把存在首次思考的 lane 视为已显式识别需求。 */
(lane) => lane.firstThought?.trim() ? [lane.variantId] : []),
      }],
    };
  }
  return {
    workflows: value.lanes.map(/** Fixture 回答没有显式规划，整理器必须如实返回空步骤。 */
(lane) => ({ variantId: lane.variantId, steps: [] })),
    outputSections: value.lanes.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(lane) => ({
      variantId: lane.variantId,
      sections: [{ label: "完整回答", startUnit: 0, endUnit: lane.answerUnits?.length ?? 0 }],
    })),
  };
}

/** 执行「serializeFixtureContext」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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

/** 执行「wait」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", cancel, { once: true });
    /** 完成当前异步桥接，并保证每条分支只结算一次。 */
function done(): void {
      signal.removeEventListener("abort", cancel);
      resolve();
    }
    /** 完成当前异步桥接，并保证每条分支只结算一次。 */
function cancel(): void {
      clearTimeout(timer);
      reject(abortError());
    }
  });
}

/** 执行「abortError」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function abortError(): Error {
  return new DOMException("模型生成已取消", "AbortError");
}
