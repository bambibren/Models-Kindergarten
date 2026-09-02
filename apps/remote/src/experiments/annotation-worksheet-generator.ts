import { createHash, randomUUID } from "node:crypto";
import type { ExperimentAnnotationWorksheet, ExperimentRecordV2 } from "@kindergarten/contracts";
import type { ModelProvider } from "../model/model-provider.js";
import { ModelStudentCatalog } from "../model/model-student-catalog.js";
import { ApiProblemError } from "../server/api-problem.js";

const PROMPT_VERSION = "annotation_worksheet_v5" as const;
const MAX_REQUIREMENTS = 30;
const MAX_STEPS = 8;
const MAX_OUTPUT_SECTIONS = 5;
const MAX_RAW_OUTPUT_SECTIONS = 50;

/** 描述「WorksheetRunEvidence」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface WorksheetRunEvidence {
  variantId: string;
  label: string;
  answer: string;
  firstThought?: string;
  modelOutputs: Array<{ kind: "thought" | "answer"; text: string }>;
}

interface RawWorksheet {
  requirements: Array<{ label: string; weight: number; sourceVariantIds: string[]; matchedVariantIds: string[] }>;
  workflows: Array<{ variantId: string; steps: string[] }>;
  outputSections: Array<{
    variantId: string;
    sections: Array<{ label: string; startUnit: number; endUnit: number }>;
  }>;
}

interface TextUnit { index: number; start: number; end: number; text: string }

/** 只让模型整理人工评测材料；这里没有 verdict、评分字段或自动评分调用。 */
export class AnnotationWorksheetGenerator {
  /** 初始化「AnnotationWorksheetGenerator」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly models: ModelProvider | ModelStudentCatalog) {}

  /** 执行「generate」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async generate(experiment: ExperimentRecordV2, evidence: WorksheetRunEvidence[]): Promise<ExperimentAnnotationWorksheet> {
    const model = this.models instanceof ModelStudentCatalog
      ? this.models.requireProvider(experiment.worksheetModelStudentId, experiment.ownerId)
      : this.models;
    if (model.student.id !== experiment.worksheetModelStudentId) {
      throw new ApiProblemError(409, "EXPERIMENT_NOT_RUNNABLE", "评测辅助 ModelStudent 与实际 Provider 不一致", false);
    }
    const units = Object.fromEntries(evidence.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(run) => [run.variantId, splitTextUnits(run.answer)]));
    if (evidence.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(run) => !run.answer.trim() || units[run.variantId]!.length === 0)) {
      throw new ApiProblemError(409, "WORKSHEET_NOT_READY", "所有 lane 都有完整回答后才能生成标注题目", true);
    }
    // 理解题目的证据输入必须物理隔离：提示词约束不足以阻止同一次模型调用参考正文或后续思考。
    const understandingInput = buildUnderstandingInput(experiment, evidence);
    const structureInput = buildStructureInput(evidence, units);
    const understandingText = await this.callModel(model, understandingInput);
    const structureText = await this.callModel(model, structureInput);
    const raw = parseRawWorksheet(understandingText, structureText, experiment);
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      worksheetId: randomUUID(),
      experimentId: experiment.experimentId,
      requirements: raw.requirements.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item, index) => ({
        requirementId: `req-${index + 1}`,
        label: item.label.trim(),
        weight: item.weight,
        sourceVariantIds: item.sourceVariantIds,
        matchedVariantIds: item.matchedVariantIds,
      })),
      workflows: raw.workflows.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(workflow) => ({
        variantId: workflow.variantId,
        steps: workflow.steps.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(label, index) => ({ stepId: `${workflow.variantId}-step-${index + 1}`, label: label.trim() })),
      })),
      outputSections: raw.outputSections.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(output) => ({
        variantId: output.variantId,
        sections: materializeSections(
          output.sections,
          units[output.variantId]!,
          evidence.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.variantId === output.variantId)!.answer,
          output.variantId,
        ),
      })),
      generator: {
        modelStudentId: model.student.id,
        providerKind: model.student.provider.kind,
        model: model.student.provider.model,
        promptVersion: PROMPT_VERSION,
        inputHash: sha256(JSON.stringify([understandingInput, structureInput])),
        outputHash: sha256(JSON.stringify([understandingText, structureText])),
        generatedAt: now,
      },
    };
  }

  /** 执行「callModel」主流程，传播取消与失败并在结束时清理临时资源。 */
private async callModel(model: ModelProvider, input: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(/** 执行受生命周期约束的定时任务，调用方负责在结束时取消句柄。 */
() => controller.abort(), 180_000);
    let text = "";
    try {
      for await (const event of model.stream({
        systemPrompt: "你是人工评测材料整理器。你只提取事实并输出 JSON，不评价回答好坏，不给分。",
        messages: [{ role: "user", content: input }],
        tools: [],
        reasoning: "disabled",
      }, controller.signal)) {
        if (event.type === "output_item_completed" && event.item.kind === "message") {
          text += event.item.text;
          if (Buffer.byteLength(text) > 2_000_000) throw new Error("模型输出超过 2 MB");
        }
        if (event.type === "output_item_started" && event.item.kind === "tool_call") {
          throw new Error("标注题目生成不允许调用 Tool");
        }
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

/** 构造理解候选项的最小证据输入，不把同一工作表的其他材料泄漏进来。 */
function buildUnderstandingInput(experiment: ExperimentRecordV2, evidence: WorksheetRunEvidence[]): string {
  const payload = {
    task: experiment.promptText,
    lanes: evidence.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(run) => ({
      variantId: run.variantId,
      ...(run.firstThought?.trim() ? { firstThought: run.firstThought } : {}),
    })),
  };
  return [
    "请为下面一次模型上下文对比实验生成理解能力人工标注选项。严格只输出一个 JSON 对象，不要 Markdown。",
    "证据边界：输入只包含用户原始 task 与每个 lane 的首次有效思考 firstThought。不得假设、补写或引用最终回答、后续思考、Tool、Runtime 结果及其他上下文。",
    "规则：",
    `1. requirements：从 task 的明确要求，以及各 firstThought 明确识别出的合理约束中，合并去重为 1-${MAX_REQUIREMENTS} 条候选需求；不得把某个 lane 的错误主张当需求，也不得根据常识扩写输入未表达的要求。`,
    "2. 每项为 {label,weight,sourceVariantIds,matchedVariantIds}，weight 为 0.1-10。label 必须是可由人工逐 lane 判断是否理解到的单一、具体要求。",
    "3. sourceVariantIds 只记录该要求的明确事实来源：task 中出现则包含特殊值 task，某 lane 的 firstThought 明确提出则包含其 variantId。",
    "4. matchedVariantIds 只记录 firstThought 明确识别到该要求的 lane；没有 firstThought 或 firstThought 未明确表达时不得列入。它不是基于最终回答的覆盖判断，也不评价理解质量。",
    "5. 不得输出正文分段、Workflow、verdict、分数、winner 或任何质量判断。",
    "JSON 结构：{\"requirements\":[{\"label\":\"...\",\"weight\":1,\"sourceVariantIds\":[\"task\",\"test-a\"],\"matchedVariantIds\":[\"test-a\"]}]}",
    "输入：",
    JSON.stringify(payload),
  ].join("\n");
}

/** 规划观察材料与正文分段可读取完整模型输出，但它们不参与理解题目生成。 */
function buildStructureInput(evidence: WorksheetRunEvidence[], units: Record<string, TextUnit[]>): string {
  const payload = {
    lanes: evidence.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(run) => ({
      variantId: run.variantId,
      label: run.label,
      modelOutputs: run.modelOutputs,
      answerUnits: units[run.variantId]!.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(unit) => ({ unit: unit.index, text: unit.text })),
    })),
  };
  return [
    "请为下面一次模型上下文对比实验整理规划观察材料与正文分段。严格只输出一个 JSON 对象，不要 Markdown。",
    "规则：",
    `1. workflows：每个 variantId 都必须出现一次；只从该 lane 的 modelOutputs（模型 thought 与 assistant 文本）中提取模型明确表达的 0-${MAX_STEPS} 个宏观任务规划，按模型表达的先后顺序输出。一个步骤表示工作目标、处理对象或预期产物的一次明显变化；连续搜索、连续参考资料、连续设计、连续实现或连续检查等同目标动作必须合并。不得把单次工具调用、模型轮次、重试、耗时或 Runtime 结果改写成规划步骤，也不得根据工具执行或最终结果反推模型没有表达过的规划。没有可观察规划时 steps 必须是空数组。steps 只写中性的规划摘要，不写有效、部分有效、分数或任何评价。`,
    `2. outputSections：每个 variantId 都必须出现一次。按主要语义目标把该 lane 的 answerUnits 拆成 1-${MAX_OUTPUT_SECTIONS} 个连续大段；不要按单句或单个列表项拆分。引出列表的说明句与紧随其后的完整列表必须放在同一段，只有主题或任务阶段明显变化时才另起一段。每段为 {label,startUnit,endUnit}，startUnit 包含、endUnit 不包含。必须从 0 开始、首尾相接、无重叠无遗漏，最后 endUnit 等于 answerUnits 数量。label 只描述该大段的整体内容。`,
    "3. 不得生成 requirements，也不得输出有效、好坏、分数、winner 或任何质量判断。",
    "JSON 结构：{\"workflows\":[{\"variantId\":\"...\",\"steps\":[\"...\"]}],\"outputSections\":[{\"variantId\":\"...\",\"sections\":[{\"label\":\"...\",\"startUnit\":0,\"endUnit\":1}]}]}",
    "输入：",
    JSON.stringify(payload),
  ].join("\n");
}

/** 校验并规范化「parseRawWorksheet」输入，非法数据直接返回明确错误。 */
function parseRawWorksheet(understandingText: string, structureText: string, experiment: ExperimentRecordV2): RawWorksheet {
  try {
    const understanding = parseJsonObject(understandingText);
    const structure = parseJsonObject(structureText);
    if (!Array.isArray(understanding.requirements)) throw new Error("缺少 requirements 数组");
    if (!Array.isArray(structure.workflows) || !Array.isArray(structure.outputSections)) throw new Error("缺少规划或分段数组");
    const variantIds = experiment.tests.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.testId);
    const requirements = understanding.requirements.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
      if (!record(item) || typeof item.label !== "string" || !item.label.trim() || typeof item.weight !== "number" || item.weight < 0.1 || item.weight > 10 ||
        !Array.isArray(item.sourceVariantIds) || !Array.isArray(item.matchedVariantIds) ||
        item.sourceVariantIds.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(id) => typeof id !== "string" || (id !== "task" && !variantIds.includes(id))) ||
        item.matchedVariantIds.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(id) => typeof id !== "string" || !variantIds.includes(id))) throw new Error("requirements 格式无效");
      return {
        label: item.label,
        weight: item.weight,
        sourceVariantIds: [...new Set(item.sourceVariantIds as string[])],
        matchedVariantIds: [...new Set(item.matchedVariantIds as string[])],
      };
    });
    if (requirements.length < 1 || requirements.length > MAX_REQUIREMENTS) throw new Error("requirements 数量无效");
    const workflows = structure.workflows.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
      if (!record(item) || typeof item.variantId !== "string" || !Array.isArray(item.steps) || item.steps.length > MAX_STEPS || item.steps.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(step) => typeof step !== "string" || !step.trim())) throw new Error("workflows 格式无效");
      return { variantId: item.variantId, steps: item.steps as string[] };
    });
    const outputSections = structure.outputSections.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
      if (!record(item) || typeof item.variantId !== "string" || !Array.isArray(item.sections) || item.sections.length < 1 || item.sections.length > MAX_RAW_OUTPUT_SECTIONS) throw new Error("outputSections 格式无效");
      return { variantId: item.variantId, sections: item.sections.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(section) => {
        if (!record(section) || typeof section.label !== "string" || !section.label.trim() || !Number.isInteger(section.startUnit) || !Number.isInteger(section.endUnit)) throw new Error("output section 格式无效");
        return { label: section.label, startUnit: section.startUnit as number, endUnit: section.endUnit as number };
      }) };
    });
    for (const group of [workflows, outputSections]) {
      if (group.length !== variantIds.length || new Set(group.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.variantId)).size !== variantIds.length || group.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !variantIds.includes(item.variantId))) throw new Error("lane 覆盖不完整");
    }
    return { requirements, workflows, outputSections };
  } catch (error) {
    throw new ApiProblemError(502, "WORKSHEET_GENERATION_INVALID", `模型返回的标注题目无法校验：${publicMessage(error)}`, true);
  }
}

/** 允许 Provider 在 JSON 外附带极短说明，但只接受其中唯一首尾对象。 */
function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("没有 JSON 对象");
  const value = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!record(value)) throw new Error("JSON 顶层必须是对象");
  return value;
}

/** 执行「materializeSections」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function materializeSections(raw: RawWorksheet["outputSections"][number]["sections"], units: TextUnit[], answer: string, variantId: string) {
  if (raw.length === 0 || units.length === 0) throw new ApiProblemError(502, "WORKSHEET_GENERATION_INVALID", `lane ${variantId} 没有可用结果分段`, true);
  // 小模型偶尔会正确识别各段含义，却把相邻 startUnit 写成跳号或重叠。
  // 这些编号只是边界建议：服务端按模型给出的顺序/标签规范化边界，
  // 并强制每个文本单元只出现一次。语义仍来自模型，原文范围不信任模型。
  const coarse = coarsenSections(raw);
  const sections = coarse.length <= units.length ? coarse : [
    ...coarse.slice(0, units.length - 1),
    { ...coarse[units.length - 1]!, label: coarse.slice(units.length - 1).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.label).join(" / ") },
  ];
  let cursor = 0;
  return sections.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(section, index) => {
    const remaining = sections.length - index - 1;
    const endUnit = index === sections.length - 1
      ? units.length
      : Math.min(units.length - remaining, Math.max(cursor + 1, section.endUnit));
    // 单元边界是提供给模型的语义锚点；字符边界主动吸收锚点间空白，使持久化区段逐字覆盖原答案而不留隐藏空洞。
    const start = index === 0 ? 0 : units[cursor]!.start;
    const end = endUnit === units.length ? answer.length : units[endUnit]!.start;
    cursor = endUnit;
    const quoted = answer.slice(start, end);
    return { answerSectionId: `${variantId}-section-${index + 1}`, label: section.label.trim(), start, end, quotedTextHash: sha256(quoted), preview: quoted.slice(0, 240) };
  });
}

/** 模型偶尔仍会按句拆分；服务端只合并相邻段，保证结果最多五个连续大块。 */
function coarsenSections(raw: RawWorksheet["outputSections"][number]["sections"]): RawWorksheet["outputSections"][number]["sections"] {
  if (raw.length <= MAX_OUTPUT_SECTIONS) return raw;
  const size = Math.ceil(raw.length / MAX_OUTPUT_SECTIONS);
  const groups: RawWorksheet["outputSections"][number]["sections"] = [];
  for (let index = 0; index < raw.length; index += size) {
    const group = raw.slice(index, index + size);
    groups.push({
      label: group.map((item) => item.label.trim()).join(" / ").slice(0, 240),
      startUnit: group[0]!.startUnit,
      endUnit: group.at(-1)!.endUnit,
    });
  }
  return groups;
}

/** 执行「splitTextUnits」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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

/** 执行「sha256」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
/** 更新「record」对应状态，并保持写入顺序、原子性与容量约束。 */
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** 执行「publicMessage」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function publicMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
