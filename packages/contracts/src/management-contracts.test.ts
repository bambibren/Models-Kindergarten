import { describe, expect, it } from "vitest";
import {
  calculateExecutionScores,
  canonicalAgentInput,
  makeExperimentRunRefMeta,
  makeSessionBindingMeta,
  parseAgentInput,
  parseExperimentDraftInput,
  parseFileReferenceUri,
  parseMcpCandidateInput,
  PRODUCT_CONFIG,
  readExperimentRunRefMeta,
  readSessionBindingMeta,
  scoreManualDimensions,
  type ExecutionMetricsSnapshot,
  type ModelStudentSummary,
} from "./index.js";

describe("management contracts", () => {
  it("严格解析并规范化 Agent 能力引用", () => {
    const input = parseAgentInput({
      name: "  代码助手  ",
      systemPrompt: "  先检查再修改。  ",
      builtinTools: [
        { toolId: "read_file", enabled: true, permission: "allow" },
        { toolId: "read_file", enabled: true, permission: "allow" },
      ],
      skillInstallationIds: ["skill-b", "skill-a", "skill-a"],
      mcps: [],
      historyPolicy: { mode: "recent_turns", maxTurns: 6 },
      memoryPolicy: { mode: "off" },
    });

    expect(input.name).toBe("代码助手");
    expect(input.systemPrompt).toBe("  先检查再修改。  ");
    expect(PRODUCT_CONFIG.agent.systemPromptMaxCharacters).toBe(32_000);
    expect(PRODUCT_CONFIG.artifact.maxRetainedRevisions).toBe(3);
    expect(canonicalAgentInput(input).skillInstallationIds).toEqual(["skill-a", "skill-b"]);
    expect(canonicalAgentInput(input).builtinTools).toHaveLength(1);
    expect(input).not.toHaveProperty("defaultReasoningProfile");
    expect(() => parseAgentInput({ ...input, memoryPolicy: { mode: "on" } })).toThrow("memoryPolicy");
  });

  it("只接受无认证的 Streamable HTTP MCP 候选", () => {
    expect(parseMcpCandidateInput({
      name: "文档 MCP",
      transport: "streamable_http",
      url: "https://mcp.example.test/api",
      auth: { kind: "none" },
    }).url).toBe("https://mcp.example.test/api");

    expect(() => parseMcpCandidateInput({
      name: "小说 MCP",
      transport: "streamable_http",
      url: "https://mcp.example.test/api",
      auth: { kind: "bearer", token: "secret" },
    })).toThrow("MCP_AUTH_NOT_SUPPORTED");
  });

  it("读取 namespaced SessionBinding/Experiment meta，并忽略未知字段", () => {
    const binding = { schemaVersion: 1 as const, modelStudentId: "student-1", agentId: "agent-1" };
    const sessionMeta = makeSessionBindingMeta(binding);
    (sessionMeta.modelKindergarten as Record<string, unknown>).future = { version: 9 };
    expect(readSessionBindingMeta(sessionMeta)?.binding).toEqual(binding);
    expect(readSessionBindingMeta({ modelKindergarten: { sessionBinding: { schemaVersion: 2 } } })).toBeUndefined();

    const runMeta = makeExperimentRunRefMeta("experiment-1", "variant-b");
    expect(readExperimentRunRefMeta(runMeta)).toEqual({
      schemaVersion: 1,
      experimentId: "experiment-1",
      variantId: "variant-b",
    });
  });

  it("实验固定为 2～3 个 lane，且 fresh 至少两个策略不同", () => {
    const policy = {
      systemPrompt: "保持简洁",
      builtinTools: [],
      skillInstallationIds: [],
      mcps: [],
      historyPolicy: { mode: "none" as const },
      memoryPolicy: { mode: "off" as const },
    };
    const draft = parseExperimentDraftInput({
      name: "上下文对比",
      mode: "fresh_prompt",
      modelStudentId: "student-1",
      sourceAgentId: "agent-1",
      promptText: "分析首屏性能",
      variants: [
        { variantId: "a", label: "A", mode: "rerun", policy },
        { variantId: "b", label: "B", mode: "rerun", policy: { ...policy, systemPrompt: "先测量再回答" } },
      ],
    });
    expect(draft.variants).toHaveLength(2);
    expect(() => parseExperimentDraftInput({ ...draft, variants: [draft.variants[0]] })).toThrow("2 到 3");
    expect(() => parseExperimentDraftInput({ ...draft, variants: [draft.variants[0], { ...draft.variants[0], variantId: "b", label: "B" }] })).toThrow("策略差异");
  });

  it("mk-file URI 只接受 opaque ID，不接受路径、host 或 query", () => {
    expect(parseFileReferenceUri("mk-file://file_8bca70a9")).toBe("file_8bca70a9");
    expect(parseFileReferenceUri("mk-file://folder/file.txt")).toBeUndefined();
    expect(parseFileReferenceUri("mk-file://file_8bca70a9?path=secret")).toBeUndefined();
    expect(parseFileReferenceUri("file:///tmp/secret.txt")).toBeUndefined();
  });

  it("ModelStudent 摘要公开手动配置的上下文上限，未知时保持字段缺省", () => {
    const known = {
      schemaVersion: 1,
      modelStudentId: "student-known",
      displayName: "Known",
      sizeClass: "large",
      providerKind: "siliconflow",
      model: "vendor/model",
      status: "ready",
      supports: {
        streaming: true,
        toolCalls: true,
        thought: true,
        usage: true,
        reasoning: {
          schemaVersion: 1,
          control: "fixed",
          adjustable: false,
          supportedProfiles: ["balanced"],
          defaultProfile: "balanced",
        },
      },
      contextWindowTokens: 262_144,
    } satisfies ModelStudentSummary;
    const { contextWindowTokens: _contextWindowTokens, ...knownWithoutContextWindow } = known;
    const unknown = {
      ...knownWithoutContextWindow,
      modelStudentId: "student-unknown",
    } satisfies ModelStudentSummary;

    expect(known.contextWindowTokens).toBe(262_144);
    expect(unknown).not.toHaveProperty("contextWindowTokens");
  });
});

describe("four-dimension score contracts", () => {
  const metrics: ExecutionMetricsSnapshot[] = [
    {
      evaluationRecordId: "eval-a",
      variantId: "a",
      normallyCompleted: true,
      firstTokenLatencyMs: 200,
      totalDurationMs: 1_000,
      toolUseWasExpected: false,
      toolSuccessCount: 0,
      toolFailureCount: 0,
      errorCount: 0,
      permissionViolationCount: 0,
      hasRepeatedToolCall: false,
      modelRoundCount: 1,
      toolCallCount: 0,
      totalContextTokens: 100,
      totalOutputTokens: 80,
    },
    {
      evaluationRecordId: "eval-b",
      variantId: "b",
      normallyCompleted: false,
      firstTokenLatencyMs: 400,
      totalDurationMs: 2_000,
      toolUseWasExpected: true,
      toolSuccessCount: 0,
      toolFailureCount: 1,
      errorCount: 2,
      permissionViolationCount: 1,
      hasRepeatedToolCall: true,
      modelRoundCount: 2,
      toolCallCount: 1,
      totalContextTokens: 120,
      totalOutputTokens: 20,
    },
  ];

  it("按 runtime_execution_v1 计算并封顶失败 lane", () => {
    const scores = calculateExecutionScores(metrics);
    expect(scores[0]).toMatchObject({ variantId: "a", score: 100 });
    expect(scores[1]?.score).toBeLessThanOrEqual(59);
    expect(scores[1]?.components.permissionSafety).toBe(0);
  });

  it("三类人工标注完成后计算可解释分数", () => {
    const scores = scoreManualDimensions({
      variantIds: ["a", "b"],
      understanding: {
        requirements: [
          { requirementId: "r1", label: "先诊断", weight: 1 },
          { requirementId: "r2", label: "说明验证", weight: 1 },
        ],
        marks: [
          { variantId: "a", requirementId: "r1", verdict: "met" },
          { variantId: "a", requirementId: "r2", verdict: "met" },
          { variantId: "b", requirementId: "r1", verdict: "met" },
          { variantId: "b", requirementId: "r2", verdict: "missed" },
        ],
        completedAt: "2026-08-12T00:00:00.000Z",
      },
      planning: {
        marks: [
          { variantId: "a", stepId: "a1", verdict: "effective" },
          { variantId: "a", stepId: "a2", verdict: "partial" },
          { variantId: "b", stepId: "b1", verdict: "none" },
        ],
        completedAt: "2026-08-12T00:00:00.000Z",
      },
      output: {
        answers: [{ variantId: "a", text: "有效 文字" }, { variantId: "b", text: "普通回答" }],
        marks: [
          { variantId: "a", answerSectionId: "a-answer", start: 0, end: 5, verdict: "effective", quotedTextHash: "hash-a" },
          { variantId: "b", answerSectionId: "b-answer", start: 0, end: 2, verdict: "partial", quotedTextHash: "hash-b" },
        ],
        completedAt: "2026-08-12T00:00:00.000Z",
      },
    });
    expect(scores.complete).toBe(true);
    expect(scores.byVariant.a?.understanding).toBe(100);
    expect(scores.byVariant.b?.understanding).toBe(50);
    expect(scores.byVariant.a?.planning).toBe(75);
    expect(scores.byVariant.a?.output).toBe(100);
  });
});
