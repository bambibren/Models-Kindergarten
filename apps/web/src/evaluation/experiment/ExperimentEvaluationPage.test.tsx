import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TurnEvaluationRecord } from "@kindergarten/evaluation-contract";
import type { SessionHistoryEntry } from "../../api/control-api.js";
import { ExecutionTrace } from "../demo/agent-evaluation/ExecutionTrace.js";
import { ArtifactOutputScore, publishedArtifactRefs } from "./ArtifactOutputScore.js";
import { WorkflowPlanningScore } from "./WorkflowPlanningScore.js";
import { toDemoExecution } from "./execution-summary.js";
import { ExperimentTabs } from "./ExperimentTabs.js";
import { ExperimentLaneContext } from "./ExperimentLaneContext.js";
import { buildOutputSegments } from "./OutputTextMarker.js";
import { reduceLiveExecution, startLiveExecution, toLiveDemoExecution } from "./live-execution.js";

describe("ExperimentEvaluationPage annotation interactions", () => {
  it("展示与 Demo 一致的 Tab 文案和人工/自动完成状态", () => {
    const html = renderToStaticMarkup(<ExperimentTabs
      active="output"
      answerStatus="completed"
      completed={{ understanding: true, planning: false, output: true }}
      onChange={() => undefined}
    />);

    expect(html).toContain("原始回答");
    expect(html).toContain("理解能力");
    expect(html).toContain("规划能力");
    expect(html).toContain("输出结果");
    expect(html).toContain("执行能力");
    expect(html).toContain("综合能力分布");
    expect(html).not.toContain("回答对比");
    expect(html.indexOf("原始回答")).toBeLessThan(html.indexOf("执行能力"));
    expect(html.indexOf("执行能力")).toBeLessThan(html.indexOf("理解能力"));
    expect(html.match(/tab-status completed/g)).toHaveLength(2);
    expect(html.match(/tab-status execution-completed/g)).toHaveLength(1);
  });

  it("单 Turn 页面只替换首个 Tab 文案并保持其余 Tab 不变", () => {
    const html = renderToStaticMarkup(<ExperimentTabs
      active="answers"
      answerLabel="流式消息"
      answerStatus="completed"
      completed={{ understanding: false, planning: false, output: false }}
      onChange={() => undefined}
    />);

    expect(html).toContain("流式消息");
    expect(html).not.toContain(">原始回答<");
    expect(html).toContain("综合能力分布");
  });

  it("原始回答流式完成前与执行能力共用 loading，且只开放这两个 Tab", () => {
    const html = renderToStaticMarkup(<ExperimentTabs
      active="answers"
      answerStatus="loading"
      completed={{ understanding: false, planning: false, output: false }}
      onChange={() => undefined}
    />);

    expect(html).toContain("answer-loading");
    expect(html).toContain("execution-loading");
    expect(html.match(/aria-busy="true"/g)).toHaveLength(2);
    expect(html.match(/tab-loading-icon/g)).toHaveLength(2);
    expect(html.match(/disabled=""/g)).toHaveLength(4);
    expect(html).toContain("执行能力生成中");
    expect(html).toContain("原始回答完成后可查看");
  });

  it("运行终态失败时执行能力显示失败状态而不是继续 loading", () => {
    const html = renderToStaticMarkup(<ExperimentTabs
      active="execution"
      answerStatus="loading"
      executionStatus="failed"
      completed={{ understanding: false, planning: false, output: false }}
      onChange={() => undefined}
    />);

    expect(html).toContain("execution-failed");
    expect(html).toContain("执行过程包含失败");
    expect(html.match(/aria-busy="true"/g)).toHaveLength(1);
  });

  it("题目生成期间三个标注 Tab 显示真实请求已耗时并保持禁用", () => {
    const html = renderToStaticMarkup(<ExperimentTabs
      active="answers"
      answerStatus="completed"
      executionStatus="completed"
      annotationStatus="loading"
      completed={{ understanding: false, planning: false, output: false }}
      onChange={() => undefined}
    />);

    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html.match(/aria-busy="true"/g)).toHaveLength(3);
    expect(html.match(/generating-elapsed/g)).toHaveLength(3);
    expect(html.match(/生成中\.\. 0s/g)).toHaveLength(3);
    expect(html).not.toContain("<progress");
    expect(html).not.toContain("tab-loading-icon");
    expect(html).toContain('title="生成中"');
  });

  it("题目生成完成后解除三个标注 Tab 禁用", () => {
    const html = renderToStaticMarkup(<ExperimentTabs
      active="understanding"
      answerStatus="completed"
      executionStatus="completed"
      annotationStatus="ready"
      completed={{ understanding: false, planning: false, output: false }}
      onChange={() => undefined}
    />);

    expect(html).not.toContain("disabled=");
    expect(html).not.toContain("generating-elapsed");
    expect(html.match(/需要手动评测/g)).toHaveLength(3);
  });

  it("原始回答标题可展开查看冻结的完整上下文配置", () => {
    const html = renderToStaticMarkup(<ExperimentLaneContext
      configuration={{ policy: { systemPrompt: "只输出事实" }, modelStudentId: "student-a" }}
      label="A"
      status="completed"
      subtitle="全新 Session"
    />);

    expect(html).toContain("<details");
    expect(html).toContain("完整上下文配置");
    expect(html).toContain("只输出事实");
  });

  it("把同一语义段内的多个绝对选区投影为独立文字标注", () => {
    const section = { answerSectionId: "section-a", label: "方案", start: 10, end: 20, text: "甲乙丙丁戊己庚辛壬癸" };
    const segments = buildOutputSegments(section, [
      { markId: "mark-1", variantId: "test-a", answerSectionId: "section-a", start: 11, end: 13, verdict: "effective", quotedTextHash: "hash-1" },
      { markId: "mark-2", variantId: "test-a", answerSectionId: "section-a", start: 15, end: 18, verdict: "partial", quotedTextHash: "hash-2" },
    ]);

    expect(segments.map((item) => item.text)).toEqual(["甲", "乙丙", "丁戊", "己庚辛", "壬癸"]);
    expect(segments.filter((item) => item.mark).map((item) => item.mark?.markId)).toEqual(["mark-1", "mark-2"]);
  });

  it("有已发布产物时只投影产物链接和满分 100 的单个评分控件", () => {
    const entries: SessionHistoryEntry[] = [
      artifactToolEntry("publish_artifact", "completed", "artifact_result", "课程网站"),
      artifactToolEntry("read_artifact", "completed", "artifact_input", "输入产物"),
      artifactToolEntry("publish_artifact_version", "failed", "artifact_failed", "失败产物"),
    ];
    const artifacts = publishedArtifactRefs(entries);
    const html = renderToStaticMarkup(<ArtifactOutputScore artifacts={artifacts} score={0} variantId="test-a" onChange={() => undefined} />);

    expect(artifacts).toEqual([{ artifactId: "artifact_result", label: "课程网站", mimeType: "text/html" }]);
    expect(html).toContain("/artifacts/artifact_result");
    expect(html).toContain("产物评分");
    expect(html).toContain('max="100"');
    expect(html).not.toContain("输入产物");
    expect(html).not.toContain("失败产物");
  });

  it("Workflow 只读展示并通过 0 到 100 滑块进行人工主观评分", () => {
    const planned = renderToStaticMarkup(<WorkflowPlanningScore
      onChange={() => undefined}
      score={73}
      steps={[{ stepId: "step-1", label: "先调研参考，再形成页面设计基线" }]}
      variantId="test-a"
    />);
    const empty = renderToStaticMarkup(<WorkflowPlanningScore onChange={() => undefined} steps={[]} variantId="test-b" />);

    expect(planned).toContain("先调研参考，再形成页面设计基线");
    expect(planned).toContain("人工主观评分");
    expect(planned).toContain('type="range"');
    expect(planned).toContain('max="100"');
    expect(planned).toContain("73");
    expect(planned).not.toContain("蓝色标记");
    expect(empty).toContain("没有可观察规划");
    expect(empty).toContain("未评分");
  });

  it("把失败的模型调用和后续重试分别展示为带耗时的执行节点", () => {
    const execution = toDemoExecution(
      { variantId: "A", status: "completed" },
      retryEvaluation(),
    );
    const html = renderToStaticMarkup(<ExecutionTrace execution={execution} />);

    expect(execution.modelRounds).toBe(1);
    expect(execution.retryCount).toBe(1);
    expect(execution.trace.filter((item) => item.type === "model")).toHaveLength(2);
    expect(html).toContain("首次调用");
    expect(html).toContain("MODEL_TRANSPORT_ERROR · Provider 连接中断");
    expect(html).toContain("失败 · 1.0 s 后重试");
    expect(html).toContain("重试 1 成功");
    expect(html).toContain("500 ms");
    expect(html).toContain("1.5 s");
  });

  it("旧 Trace 没有 Attempt 时仍把未完成模型节点标成失败并计算已耗时", () => {
    const evaluation = retryEvaluation();
    evaluation.trace.status = "failed";
    evaluation.trace.stopReason = "MODEL_STREAM_IDLE_TIMEOUT";
    delete evaluation.trace.modelRounds[0]!.attempts;
    delete evaluation.trace.modelRounds[0]!.completedAt;

    const execution = toDemoExecution({ variantId: "A", status: "failed" }, evaluation);
    const modelNode = execution.trace.find((item) => item.type === "model");

    expect(modelNode?.status).toBe("failed");
    expect(modelNode?.duration).toBe("4.0 s");
  });

  it("ExecutionTrace 显示实时进行中的模型节点", () => {
    const state = reduceLiveExecution(startLiveExecution("turn-live", 1_000), {
      schemaVersion: 1,
      turnId: "turn-live",
      sequence: 0,
      type: "model_attempt_started",
      roundIndex: 0,
      attemptId: "attempt-live",
      attemptIndex: 0,
      maxAttempts: 6,
      startedAt: 1_100,
    });
    const html = renderToStaticMarkup(<ExecutionTrace execution={toLiveDemoExecution(state, 1_600)} />);

    expect(html).toContain("status-running");
    expect(html).toContain("正在等待模型响应");
    expect(html).toContain("进行中");
    expect(html).toContain("500 ms");
  });
});

function artifactToolEntry(name: string, status: "completed" | "failed", artifactId: string, title: string): SessionHistoryEntry {
  return {
    type: "tool_call",
    turnId: "turn-a",
    toolCallId: `call-${artifactId}`,
    title: name,
    name,
    kind: "edit",
    status,
    rawInput: {},
    content: [{ type: "content", content: { type: "resource_link", uri: `artifact://${artifactId}`, name: title, title, mimeType: "text/html" } }],
    locations: [],
    createdAt: "2026-09-02T00:00:00.000Z",
  };
}

function retryEvaluation(): TurnEvaluationRecord {
  const reasoning = {
    schemaVersion: 1 as const,
    requestedProfile: "auto" as const,
    resolvedProfile: "balanced" as const,
    source: "model_default" as const,
    providerKind: "fixture",
    model: "fixture-model",
    native: {},
  };
  return {
    schemaVersion: 2,
    createdAt: "2026-09-02T00:00:00.000Z",
    result: {
      normallyCompleted: true,
      modelRoundCount: 1,
      toolCallCount: 0,
      toolSuccessCount: 0,
      toolFailureCount: 0,
      hasRepeatedToolCall: false,
      totalContextTokens: 10,
      truncatedContextItemCount: 0,
      totalDurationMs: 4_000,
      totalOutputTokens: 42,
      errorCount: 0,
      permissionViolationCount: 0,
    },
    trace: {
      schemaVersion: 2,
      traceId: "trace-retry",
      runId: "run-retry",
      sessionId: "session-retry",
      turnId: "turn-retry",
      variant: {
        studentId: "student-a",
        studentName: "Student A",
        provider: "fixture",
        model: "fixture-model",
        systemPromptHash: "system-hash",
        runtimeVersion: "test",
        toolNames: [],
      },
      resolvedReasoning: reasoning,
      status: "completed",
      startedAt: 1_000,
      completedAt: 5_000,
      modelRounds: [{
        id: "round-1",
        index: 0,
        startedAt: 1_000,
        completedAt: 4_000,
        stopReason: "stop",
        resolvedReasoning: reasoning,
        context: { messages: [], truncatedSourceIds: [], inputTokens: 10 },
        outputTokens: 42,
        attempts: [
          {
            id: "attempt-0",
            index: 0,
            startedAt: 1_000,
            completedAt: 1_500,
            status: "failed",
            error: { code: "MODEL_TRANSPORT_ERROR", message: "Provider 连接中断", retryable: true },
            retryDelayMs: 1_000,
          },
          { id: "attempt-1", index: 1, startedAt: 2_500, completedAt: 4_000, status: "completed" },
        ],
      }],
      toolCalls: [],
      permissions: [],
      errors: [],
    },
  };
}
