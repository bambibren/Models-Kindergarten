import { describe, expect, it } from "vitest";
import type { ExperimentRecordV2 } from "@kindergarten/contracts";
import { AnnotationWorksheetGenerator } from "../../src/experiments/annotation-worksheet-generator.js";
import { FixtureProvider } from "../../src/model/fixture-provider.js";
import { ModelStudentCatalog } from "../../src/model/model-student-catalog.js";
import type { ModelEvent, ModelInput } from "../../src/model/model-provider.js";

class BoundaryDriftProvider extends FixtureProvider {
  /** 构造「stream」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
override async *stream(_input: ModelInput, _signal: AbortSignal): AsyncIterable<ModelEvent> {
    yield { type: "text_delta", text: JSON.stringify({
      requirements: [{ label: "完整回答任务", weight: 1 }],
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
    }) };
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

describe("AnnotationWorksheetGenerator", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("保留模型分段语义并把小模型漂移的编号规范化为完整连续原文", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const generator = new AnnotationWorksheetGenerator(new BoundaryDriftProvider());
    const answers = ["第一点。\n\n第二点。", "甲。\n乙。"];
    const worksheet = await generator.generate(experiment(), [
      { variantId: "variant-a", label: "A", answer: answers[0]!, toolEvents: [] },
      { variantId: "variant-b", label: "B", answer: answers[1]!, toolEvents: [] },
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
  });

  it("从目录解析显式选择的非默认工作表 ModelStudent，并记录同一个真实 Provider", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const catalog = new ModelStudentCatalog(new FixtureProvider(), "ready");
    catalog.register(new AlternateWorksheetProvider(), { initialStatus: "ready" });
    const generator = new AnnotationWorksheetGenerator(catalog);
    const input = { ...experiment(), worksheetModelStudentId: "alternate-worksheet-student" };
    const worksheet = await generator.generate(input, [
      { variantId: "variant-a", label: "A", answer: "第一点。\n\n第二点。", toolEvents: [] },
      { variantId: "variant-b", label: "B", answer: "甲。\n乙。", toolEvents: [] },
    ]);

    expect(worksheet.generator).toMatchObject({
      modelStudentId: "alternate-worksheet-student",
      providerKind: "ollama",
      model: "worksheet-fixture",
    });
  });
});

/** 构造「experiment」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function experiment(): ExperimentRecordV2 {
  const now = new Date().toISOString();
  const policy = {
    systemPrompt: "test", builtinTools: [], skillInstallationIds: [], mcps: [],
    historyPolicy: { mode: "none" as const, maxTurns: 0 }, memoryPolicy: { mode: "off" as const },
  };
  return {
    schemaVersion: 2, experimentId: "experiment", ownerId: "local-admin", name: "test",
    status: "completed", worksheetModelStudentId: "fixture-student",
    promptText: "回答两点", toolUseWasExpected: false,
    tests: [
      { testId: "variant-a", label: "A", sourceAgent: { agentId: "agent", name: "Agent", updatedAt: now }, modelStudentId: "fixture-student", reasoningProfile: "auto", policy },
      { testId: "variant-b", label: "B", sourceAgent: { agentId: "agent", name: "Agent", updatedAt: now }, modelStudentId: "fixture-student", reasoningProfile: "auto", policy },
    ],
    runs: [], createdAt: now, updatedAt: now,
  };
}
