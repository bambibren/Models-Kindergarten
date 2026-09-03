import { describe, expect, it } from "vitest";
import type { ExperimentRecordV2 } from "@kindergarten/contracts";
import { AnnotationWorksheetGenerator } from "../../src/experiments/annotation-worksheet-generator.js";
import { FixtureProvider } from "../../src/model/fixture-provider.js";
import { ModelStudentCatalog } from "../../src/model/model-student-catalog.js";
import type { ModelEvent, ModelInput } from "../../src/model/model-provider.js";
import { messageEvents } from "../support/model-events.js";

class BoundaryDriftProvider extends FixtureProvider {
  /** 构造「stream」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
override async *stream(_input: ModelInput, _signal: AbortSignal): AsyncIterable<ModelEvent> {
    yield* messageEvents(JSON.stringify({
      requirements: [{
        label: "完整回答任务",
        weight: 1,
        sourceVariantIds: ["task", "variant-a", "variant-b"],
        matchedVariantIds: ["variant-a", "variant-b"],
      }],
      workflows: [
        { variantId: "variant-a", steps: ["形成两点回答"] },
        { variantId: "variant-b", steps: ["形成两点回答"] },
      ],
      outputSections: [
        { variantId: "variant-a", sections: [
          { label: "第一点", startUnit: 0, endUnit: 1 },
          { label: "第二点", startUnit: 2, endUnit: 999 },
        ] },
        { variantId: "variant-b", sections: [{ label: "完整回答", startUnit: 1, endUnit: 1 }] },
      ],
    }));
    yield { type: "finish", reason: "stop" };
  }
}

class AlternateWorksheetProvider extends BoundaryDriftProvider {
  override readonly student = {
    id: "alternate-worksheet-student",
    name: "Alternate Worksheet Student",
    sizeClass: "large" as const,
    provider: { kind: "ollama" as const, model: "worksheet-fixture", baseUrl: "http://127.0.0.1" },
    generationDefaults: { reasoningProfile: "balanced" as const },
  };
}

class FragmentedWorksheetProvider extends FixtureProvider {
  lastInput = "";
  readonly inputs: string[] = [];

  override async *stream(input: ModelInput, _signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.lastInput = input.messages.at(-1)?.content ?? "";
    this.inputs.push(this.lastInput);
    const sections = Array.from({ length: 8 }, (_, index) => ({ label: `碎片 ${index + 1}`, startUnit: index, endUnit: index + 1 }));
    yield* messageEvents(JSON.stringify({
      requirements: [{ label: "完整回答任务", weight: 1, sourceVariantIds: ["task"], matchedVariantIds: ["variant-a", "variant-b"] }],
      workflows: [
        { variantId: "variant-a", steps: ["形成回答"] },
        { variantId: "variant-b", steps: ["形成回答"] },
      ],
      outputSections: [
        { variantId: "variant-a", sections },
        { variantId: "variant-b", sections },
      ],
    }));
    yield { type: "finish", reason: "stop" };
  }
}

describe("AnnotationWorksheetGenerator", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("模型输出没有显式规划时保留空 Workflow，不从工具或结果反推步骤", async () => {
    const generator = new AnnotationWorksheetGenerator(new FixtureProvider());
    const worksheet = await generator.generate(experiment(), [
      { variantId: "variant-a", label: "A", answer: "页面已经完成。", modelOutputs: [{ kind: "answer", text: "页面已经完成。" }] },
      { variantId: "variant-b", label: "B", answer: "这是最终结果。", modelOutputs: [{ kind: "answer", text: "这是最终结果。" }] },
    ]);

    expect(worksheet.workflows.every((workflow) => workflow.steps.length === 0)).toBe(true);
    expect(worksheet.generator.promptVersion).toBe("annotation_worksheet_v5");
  });

  it("保留模型分段语义并把小模型漂移的编号规范化为完整连续原文", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const generator = new AnnotationWorksheetGenerator(new BoundaryDriftProvider());
    const answers = ["第一点。\n\n第二点。", "甲。\n乙。"];
    const worksheet = await generator.generate(experiment(), [
      { variantId: "variant-a", label: "A", answer: answers[0]!, modelOutputs: [{ kind: "thought", text: "先理解问题，再形成两点回答。" }] },
      { variantId: "variant-b", label: "B", answer: answers[1]!, modelOutputs: [{ kind: "answer", text: answers[1]! }] },
    ]);

    for (const [index, output] of worksheet.outputSections.entries()) {
      expect(output.sections[0]?.start).toBe(0);
      expect(output.sections.at(-1)?.end).toBe(answers[index]!.length);
      for (let sectionIndex = 1; sectionIndex < output.sections.length; sectionIndex += 1) {
        expect(output.sections[sectionIndex - 1]?.end).toBe(output.sections[sectionIndex]?.start);
      }
    }
    expect(worksheet.outputSections[0]?.sections.map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.label)).toEqual(["第一点", "第二点"]);
    expect(worksheet.requirements[0]).toMatchObject({
      sourceVariantIds: ["task", "variant-a", "variant-b"],
      matchedVariantIds: ["variant-a", "variant-b"],
    });
    expect(worksheet.generator.promptVersion).toBe("annotation_worksheet_v5");
  });

  it("从目录解析显式选择的非默认工作表 ModelStudent，并记录同一个真实 Provider", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const catalog = new ModelStudentCatalog(new FixtureProvider(), "ready");
    catalog.register(new AlternateWorksheetProvider(), { initialStatus: "ready" });
    const generator = new AnnotationWorksheetGenerator(catalog);
    const input = { ...experiment(), worksheetModelStudentId: "alternate-worksheet-student" };
    const worksheet = await generator.generate(input, [
      { variantId: "variant-a", label: "A", answer: "第一点。\n\n第二点。", modelOutputs: [{ kind: "answer", text: "第一点。\n\n第二点。" }] },
      { variantId: "variant-b", label: "B", answer: "甲。\n乙。", modelOutputs: [{ kind: "answer", text: "甲。\n乙。" }] },
    ]);

    expect(worksheet.generator).toMatchObject({
      modelStudentId: "alternate-worksheet-student",
      providerKind: "ollama",
      model: "worksheet-fixture",
    });
  });

  it("提示模型按大块拆分，并把过碎结果强制合并到最多五块", async () => {
    const provider = new FragmentedWorksheetProvider();
    const generator = new AnnotationWorksheetGenerator(provider);
    const answer = "一。二。三。四。五。六。七。八。";
    const worksheet = await generator.generate(experiment(), [
      { variantId: "variant-a", label: "A", answer, modelOutputs: [{ kind: "thought", text: "先整理，再回答。" }] },
      { variantId: "variant-b", label: "B", answer, modelOutputs: [{ kind: "answer", text: answer }] },
    ]);

    expect(provider.lastInput).toContain("1-5 个连续大段");
    expect(provider.lastInput).toContain("完整列表必须放在同一段");
    expect(provider.lastInput).toContain("没有可观察规划时 steps 必须是空数组");
    expect(provider.lastInput).toContain('"modelOutputs"');
    expect(provider.lastInput).not.toContain("toolEvents");
    expect(worksheet.outputSections.every((item) => item.sections.length <= 5)).toBe(true);
    expect(worksheet.outputSections[0]?.sections[0]?.label).toBe("碎片 1 / 碎片 2");
  });

  it("理解选项调用只接收用户 Prompt 与每个 lane 的首次思考", async () => {
    const provider = new FragmentedWorksheetProvider();
    const generator = new AnnotationWorksheetGenerator(provider);
    await generator.generate(experiment(), [
      {
        variantId: "variant-a",
        label: "A",
        answer: "禁止进入理解调用的正文 A",
        firstThought: "允许进入理解调用的首次思考 A",
        modelOutputs: [
          { kind: "thought", text: "允许进入理解调用的首次思考 A" },
          { kind: "thought", text: "禁止进入理解调用的后续思考 A" },
          { kind: "answer", text: "禁止进入理解调用的正文 A" },
        ],
      },
      {
        variantId: "variant-b",
        label: "B",
        answer: "禁止进入理解调用的正文 B",
        modelOutputs: [{ kind: "answer", text: "禁止进入理解调用的正文 B" }],
      },
    ]);

    expect(provider.inputs).toHaveLength(2);
    const understandingInput = provider.inputs[0]!;
    const structureInput = provider.inputs[1]!;
    const marker = "输入：\n";
    expect(JSON.parse(understandingInput.slice(understandingInput.lastIndexOf(marker) + marker.length))).toEqual({
      task: "回答两点",
      lanes: [
        { variantId: "variant-a", firstThought: "允许进入理解调用的首次思考 A" },
        { variantId: "variant-b" },
      ],
    });
    expect(understandingInput).toContain('"task":"回答两点"');
    expect(understandingInput).toContain("允许进入理解调用的首次思考 A");
    expect(understandingInput).not.toContain("禁止进入理解调用的后续思考 A");
    expect(understandingInput).not.toContain("禁止进入理解调用的正文 A");
    expect(understandingInput).not.toContain("禁止进入理解调用的正文 B");
    expect(understandingInput).not.toContain('"modelOutputs"');
    expect(understandingInput).not.toContain('"answerUnits"');
    expect(structureInput).toContain("禁止进入理解调用的后续思考 A");
    expect(structureInput).toContain("禁止进入理解调用的正文 A");
  });
});

/** 构造「experiment」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function experiment(): ExperimentRecordV2 {
  const now = new Date().toISOString();
  const policy = {
    systemPrompt: "test", builtinTools: [], builtinSkillIds: [], skillInstallationIds: [], mcps: [],
    historyPolicy: { mode: "none" as const, maxTurns: 0 }, memoryPolicy: { mode: "off" as const },
  };
  return {
    schemaVersion: 2, experimentId: "experiment", ownerId: "local-admin", name: "test",
    status: "completed", worksheetModelStudentId: "fixture-student",
    promptText: "回答两点",
    tests: [
      { testId: "variant-a", label: "A", sourceAgent: { agentId: "agent", name: "Agent", updatedAt: now }, modelStudentId: "fixture-student", reasoningProfile: "auto", policy },
      { testId: "variant-b", label: "B", sourceAgent: { agentId: "agent", name: "Agent", updatedAt: now }, modelStudentId: "fixture-student", reasoningProfile: "auto", policy },
    ],
    runs: [], createdAt: now, updatedAt: now,
  };
}
