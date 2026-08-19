import { createHash, randomUUID } from "node:crypto";
import type { ExperimentAnnotationWorksheet, ExperimentRecordV2 } from "@kindergarten/contracts";
import type { ModelProvider } from "../model/model-provider.js";
import { ModelStudentCatalog } from "../model/model-student-catalog.js";
import { ApiProblemError } from "../server/api-problem.js";

const PROMPT_VERSION = "annotation_worksheet_v1" as const;
const MAX_REQUIREMENTS = 30;
const MAX_STEPS = 40;

export interface WorksheetRunEvidence {
  variantId: string;
  label: string;
  answer: string;
  toolEvents: Array<{ name: string; title: string; status: string }>;
}

interface RawWorksheet {
  requirements: Array<{ label: string; weight: number }>;
  workflows: Array<{ variantId: string; steps: string[] }>;
  outputSections: Array<{
    variantId: string;
    sections: Array<{ label: string; startUnit: number; endUnit: number }>;
  }>;
}

interface TextUnit { index: number; start: number; end: number; text: string }

/** 只让模型整理人工标注题目；这里没有 verdict、评分字段或自动评分调用。 */
export class AnnotationWorksheetGenerator {
  constructor(private readonly models: ModelProvider | ModelStudentCatalog) {}

  async generate(experiment: ExperimentRecordV2, evidence: WorksheetRunEvidence[]): Promise<ExperimentAnnotationWorksheet> {
    const model = this.models instanceof ModelStudentCatalog
      ? this.models.requireProvider(experiment.worksheetModelStudentId)
      : this.models;
    if (model.student.id !== experiment.worksheetModelStudentId) {
      throw new ApiProblemError(409, "EXPERIMENT_NOT_RUNNABLE", "评测辅助 ModelStudent 与实际 Provider 不一致", false);
    }
    const units = Object.fromEntries(evidence.map((run) => [run.variantId, splitTextUnits(run.answer)]));
    if (evidence.some((run) => !run.answer.trim() || units[run.variantId]!.length === 0)) {
      throw new ApiProblemError(409, "WORKSHEET_NOT_READY", "所有 lane 都有完整回答后才能生成标注题目", true);
    }
    const input = buildInput(experiment, evidence, units);
    const rawText = await this.callModel(model, input);
    const raw = parseRawWorksheet(rawText, experiment);
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      worksheetId: randomUUID(),
      experimentId: experiment.experimentId,
      requirements: raw.requirements.map((item, index) => ({
        requirementId: `req-${index + 1}`,
        label: item.label.trim(),
        weight: item.weight,
      })),
      workflows: raw.workflows.map((workflow) => ({
        variantId: workflow.variantId,
        steps: workflow.steps.map((label, index) => ({ stepId: `${workflow.variantId}-step-${index + 1}`, label: label.trim() })),
      })),
      outputSections: raw.outputSections.map((output) => ({
        variantId: output.variantId,
        sections: materializeSections(
          output.sections,
          units[output.variantId]!,
          evidence.find((item) => item.variantId === output.variantId)!.answer,
          output.variantId,
        ),
      })),
      generator: {
        modelStudentId: model.student.id,
        providerKind: model.student.provider.kind,
        model: model.student.provider.model,
        promptVersion: PROMPT_VERSION,
        inputHash: sha256(input),
        outputHash: sha256(rawText),
        generatedAt: now,
      },
    };
  }

  private async callModel(model: ModelProvider, input: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);
    let text = "";
    try {
      for await (const event of model.stream({
        systemPrompt: "你是人工评测题目整理器。你只提取事实并输出 JSON，不评价回答好坏，不给分。",
        messages: [{ role: "user", content: input }],
        tools: [],
        reasoning: "disabled",
      }, controller.signal)) {
        if (event.type === "text_delta") {
          text += event.text;
          if (Buffer.byteLength(text) > 2_000_000) throw new Error("模型输出超过 2 MB");
        }
        if (event.type === "tool_calls") throw new Error("标注题目生成不允许调用 Tool");
      }
    } catch (error) {
      throw new ApiProblemError(502, "WORKSHEET_GENERATION_FAILED", `标注题目生成失败：${publicMessage(error)}`, true);
    } finally {
      clearTimeout(timeout);
    }
    if (!text.trim()) throw new ApiProblemError(502, "WORKSHEET_GENERATION_FAILED", "模型没有返回标注题目", true);
    return text;
  }
}

function buildInput(experiment: ExperimentRecordV2, evidence: WorksheetRunEvidence[], units: Record<string, TextUnit[]>): string {
  const payload = {
    task: experiment.promptText,
    lanes: evidence.map((run) => ({
      variantId: run.variantId,
      label: run.label,
      toolEvents: run.toolEvents,
      answerUnits: units[run.variantId]!.map((unit) => ({ unit: unit.index, text: unit.text })),
    })),
  };
  return [
    "请为下面一次模型上下文对比实验生成三组人工标注题目。严格只输出一个 JSON 对象，不要 Markdown。",
    "规则：",
    `1. requirements：分析原始 task，并参考所有 lane 暴露出的合理约束，合并去重为 1-${MAX_REQUIREMENTS} 条公共需求；不得把某个 lane 的错误主张当需求。每项为 {label,weight}，weight 为 0.1-10。`,
    `2. workflows：每个 variantId 都必须出现一次；综合该 lane 的回答与 toolEvents，按实际先后提取 1-${MAX_STEPS} 个可独立判断的工作步骤。steps 是字符串数组，不写评价。`,
    "3. outputSections：每个 variantId 都必须出现一次。把该 lane 的 answerUnits 分成若干连续结果段；每段为 {label,startUnit,endUnit}，startUnit 包含、endUnit 不包含。必须从 0 开始、首尾相接、无重叠无遗漏，最后 endUnit 等于 answerUnits 数量。label 只描述该段内容。",
    "4. 不得输出命中、有效、好坏、分数、winner 或任何自动判断。",
    "JSON 结构：{\"requirements\":[{\"label\":\"...\",\"weight\":1}],\"workflows\":[{\"variantId\":\"...\",\"steps\":[\"...\"]}],\"outputSections\":[{\"variantId\":\"...\",\"sections\":[{\"label\":\"...\",\"startUnit\":0,\"endUnit\":1}]}]}",
    "输入：",
    JSON.stringify(payload),
  ].join("\n");
}

function parseRawWorksheet(text: string, experiment: ExperimentRecordV2): RawWorksheet {
  try {
    const start = text.indexOf("{"); const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("没有 JSON 对象");
    const value = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!record(value) || !Array.isArray(value.requirements) || !Array.isArray(value.workflows) || !Array.isArray(value.outputSections)) throw new Error("缺少数组字段");
    const requirements = value.requirements.map((item) => {
      if (!record(item) || typeof item.label !== "string" || !item.label.trim() || typeof item.weight !== "number" || item.weight < 0.1 || item.weight > 10) throw new Error("requirements 格式无效");
      return { label: item.label, weight: item.weight };
    });
    if (requirements.length < 1 || requirements.length > MAX_REQUIREMENTS) throw new Error("requirements 数量无效");
    const variantIds = experiment.tests.map((item) => item.testId);
    const workflows = value.workflows.map((item) => {
      if (!record(item) || typeof item.variantId !== "string" || !Array.isArray(item.steps) || item.steps.length < 1 || item.steps.length > MAX_STEPS || item.steps.some((step) => typeof step !== "string" || !step.trim())) throw new Error("workflows 格式无效");
      return { variantId: item.variantId, steps: item.steps as string[] };
    });
    const outputSections = value.outputSections.map((item) => {
      if (!record(item) || typeof item.variantId !== "string" || !Array.isArray(item.sections) || item.sections.length < 1) throw new Error("outputSections 格式无效");
      return { variantId: item.variantId, sections: item.sections.map((section) => {
        if (!record(section) || typeof section.label !== "string" || !section.label.trim() || !Number.isInteger(section.startUnit) || !Number.isInteger(section.endUnit)) throw new Error("output section 格式无效");
        return { label: section.label, startUnit: section.startUnit as number, endUnit: section.endUnit as number };
      }) };
    });
    for (const group of [workflows, outputSections]) {
      if (group.length !== variantIds.length || new Set(group.map((item) => item.variantId)).size !== variantIds.length || group.some((item) => !variantIds.includes(item.variantId))) throw new Error("lane 覆盖不完整");
    }
    return { requirements, workflows, outputSections };
  } catch (error) {
    throw new ApiProblemError(502, "WORKSHEET_GENERATION_INVALID", `模型返回的标注题目无法校验：${publicMessage(error)}`, true);
  }
}

function materializeSections(raw: RawWorksheet["outputSections"][number]["sections"], units: TextUnit[], answer: string, variantId: string) {
  if (raw.length === 0 || units.length === 0) throw new ApiProblemError(502, "WORKSHEET_GENERATION_INVALID", `lane ${variantId} 没有可用结果分段`, true);
  // 小模型偶尔会正确识别各段含义，却把相邻 startUnit 写成跳号或重叠。
  // 这些编号只是边界建议：服务端按模型给出的顺序/标签规范化边界，
  // 并强制每个文本单元只出现一次。语义仍来自模型，原文范围不信任模型。
  const sections = raw.length <= units.length ? raw : [
    ...raw.slice(0, units.length - 1),
    { ...raw[units.length - 1]!, label: raw.slice(units.length - 1).map((item) => item.label).join(" / ") },
  ];
  let cursor = 0;
  return sections.map((section, index) => {
    const remaining = sections.length - index - 1;
    const endUnit = index === sections.length - 1
      ? units.length
      : Math.min(units.length - remaining, Math.max(cursor + 1, section.endUnit));
    // Unit boundaries are semantic anchors for the model. Character boundaries
    // deliberately absorb the whitespace between anchors so the persisted
    // sections cover the original answer byte-for-byte with no hidden gaps.
    const start = index === 0 ? 0 : units[cursor]!.start;
    const end = endUnit === units.length ? answer.length : units[endUnit]!.start;
    cursor = endUnit;
    const quoted = answer.slice(start, end);
    return { answerSectionId: `${variantId}-section-${index + 1}`, label: section.label.trim(), start, end, quotedTextHash: sha256(quoted), preview: quoted.slice(0, 240) };
  });
}

function splitTextUnits(text: string): TextUnit[] {
  const units: TextUnit[] = [];
  const pattern = /[^。！？!?；;\n]+[。！？!?；;]?|\n+/gu;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0]; const leading = raw.match(/^\s*/u)?.[0].length ?? 0; const trailing = raw.match(/\s*$/u)?.[0].length ?? 0;
    const start = (match.index ?? 0) + leading; const end = (match.index ?? 0) + raw.length - trailing;
    if (end > start) units.push({ index: units.length, start, end, text: text.slice(start, end) });
  }
  return units;
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function publicMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
