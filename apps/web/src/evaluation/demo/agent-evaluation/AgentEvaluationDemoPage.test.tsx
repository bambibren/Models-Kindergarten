import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentEvaluationDemoPage } from "./AgentEvaluationDemoPage.js";
import { AnnotationTabs } from "./AnnotationTabs.js";
import { DemoAgentStream } from "./DemoAgentStream.js";
import { DemoArtifactPage } from "./DemoArtifactPage.js";
import { demoAgents, demoArtifacts } from "./mock-data.js";

describe("agent evaluation result demo", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("任务区只展示原始提示词", () => {
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("history", { back: () => undefined });
    const html = renderToStaticMarkup(<AgentEvaluationDemoPage />);
    expect(html).toContain("请分析当前 React 项目首屏加载缓慢的问题");
    expect(html).not.toContain("React 首屏性能诊断");
    expect(html).not.toContain("USER TASK");
  });

  it("把原始回答与评分模块放在同一层 Tab", () => {
    const html = renderToStaticMarkup(<AnnotationTabs active="answer" completed={{}} onChange={() => undefined} />);
    expect(html).toContain("原始回答");
    expect(html).toContain("理解能力");
    expect(html).toContain("执行能力");
    expect(html).not.toContain("回答对比");
  });

  it("从原始回答在新页面打开 Demo 产物", () => {
    const html = renderToStaticMarkup(<DemoAgentStream agent={demoAgents[0]!} artifacts={demoArtifacts} />);
    expect(html).toContain('target="_blank"');
    expect(html).toContain("/evaluation/demo/agent-comparison/artifacts/artifact-performance-observations");
    expect(html).toContain("performance-observations.md");
  });

  it("执行轨迹与摘要中的模型轮次和工具数量一致", () => {
    for (const agent of demoAgents) {
      expect(agent.execution.trace.filter((item) => item.type === "model")).toHaveLength(agent.execution.modelRounds);
      expect(agent.execution.trace.filter((item) => item.type === "tool")).toHaveLength(agent.execution.toolCalls);
    }
    expect(demoAgents.some((agent) => agent.execution.trace.some((item) => item.status === "failed"))).toBe(true);
  });

  it("使用独立页面展示 HTML 产物", () => {
    const html = renderToStaticMarkup(<DemoArtifactPage artifactId="artifact-performance-plan" />);
    expect(html).toContain("DEMO ARTIFACT · STANDALONE PAGE");
    expect(html).toContain("performance-plan.html");
    expect(html).toContain("<iframe");
  });
});
