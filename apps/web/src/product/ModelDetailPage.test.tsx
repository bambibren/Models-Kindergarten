import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ModelStudentDetailView } from "@kindergarten/contracts";
import { ModelDetailContent, ModelDetailPage, modelStudentDetailUrl } from "./ModelDetailPage.js";

describe("ModelDetailPage", /** 组织模型只读详情的页面与路径测试。 */
() => {
  it("加载期间也提供返回 Models 列表的入口", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const html = renderToStaticMarkup(<ModelDetailPage modelStudentId="student-1" />);
    expect(html).toContain("模型入园信息");
    expect(html).toContain("此页面只读");
    expect(html).toContain('href="/me?tab=models"');
  });

  it("完整展示安全入园信息且没有编辑或保存入口", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const html = renderToStaticMarkup(<ModelDetailContent detail={detail()} />);
    expect(html).toContain("大聪明");
    expect(html).toContain("自定义 Responses");
    expect(html).toContain("https://models.example.test/v1");
    expect(html).toContain("gpt-5.5");
    expect(html).toContain("1,050,000");
    expect(html).toContain("已安全保存 · ••••cret");
    expect(html).toContain("均衡");
    expect(html).toContain("Tool 结果续接");
    expect(html).toContain("未通过");
    expect(html).not.toContain("保存修改");
    expect(html).not.toContain("input");
    expect(html).not.toContain("credentialRef");
    expect(html).not.toContain("sk-secret");
  });

  it("对路径中的模型 ID 做完整编码", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(modelStudentDetailUrl("student/大聪明"))
      .toBe("/models/student%2F%E5%A4%A7%E8%81%AA%E6%98%8E");
  });
});

/** 构造不含任何明文 Secret 的模型详情。 */
function detail(): ModelStudentDetailView {
  return {
    schemaVersion: 1,
    modelStudentId: "student-1",
    displayName: "大聪明",
    sizeClass: "large",
    providerKind: "openai-compatible",
    model: "gpt-5.5",
    status: "ready",
    supports: {
      streaming: true,
      toolCalls: false,
      thought: true,
      usage: true,
      reasoning: {
        schemaVersion: 1,
        control: "effort_levels",
        adjustable: true,
        supportedProfiles: ["fast", "balanced", "deep"],
        defaultProfile: "balanced",
      },
    },
    contextWindowTokens: 1_050_000,
    deletable: true,
    admission: {
      schemaVersion: 1,
      presetId: "custom_responses",
      protocol: "openai_responses",
      baseUrl: "https://models.example.test/v1",
      credentialConfigured: true,
      credentialHint: "••••cret",
      defaultReasoningProfile: "balanced",
      snapshot: {
        schemaVersion: 1,
        protocol: "openai_responses",
        adapterRevision: "test-v1",
        probeVersion: 1,
        connectionFingerprint: "fingerprint",
        streaming: true,
        text: true,
        toolCalls: false,
        toolContinuation: false,
        usage: true,
        thought: true,
        reasoning: {
          capability: {
            schemaVersion: 1,
            control: "effort_levels",
            adjustable: true,
            supportedProfiles: ["fast", "balanced", "deep"],
            defaultProfile: "balanced",
          },
          nativeByProfile: {
            fast: { reasoning: "low" },
            balanced: { reasoning: "medium" },
            deep: { reasoning: "high" },
          },
          acceptedNativeValues: [{ reasoning: "low" }, { reasoning: "medium" }, { reasoning: "high" }],
        },
        testedAt: "2026-08-31T00:00:00.000Z",
      },
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    },
  };
}
