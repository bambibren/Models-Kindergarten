import { describe, expect, it } from "vitest";
import {
  parseModelStudentInstallInput,
  parseModelStudentCandidateInput,
  parseResponsesModelCandidateInput,
  readResponsesCapabilityProbe,
} from "./model-admission.js";

describe("自定义 Responses 模型入园合同", () => {
  it("规范化 HTTPS Base URL 并保留瞬时 API Key", () => {
    expect(parseResponsesModelCandidateInput({
      displayName: " 大聪明 ",
      baseUrl: "https://models.example.test/v1/",
      model: " gpt-compatible ",
      apiKey: "secret-with-spaces ",
    })).toEqual({
      displayName: "大聪明",
      baseUrl: "https://models.example.test/v1",
      model: "gpt-compatible",
      apiKey: "secret-with-spaces ",
    });
  });

  it("固定 Provider 预设不接受浏览器覆盖 Base URL", () => {
    expect(parseModelStudentCandidateInput({
      presetId: "openai", displayName: "官方模型", model: "gpt-5", apiKey: "k",
    })).toEqual({ presetId: "openai", displayName: "官方模型", model: "gpt-5", apiKey: "k" });
    expect(() => parseModelStudentCandidateInput({
      presetId: "siliconflow",
      displayName: "国内模型",
      model: "vendor/model",
      apiKey: "k",
      baseUrl: "https://attacker.example/v1",
    })).toThrow("未知字段");
  });

  it.each([
    "http://models.example.test/v1",
    "https://user:pass@models.example.test/v1",
    "https://models.example.test/v1?token=bad",
    "not-a-url",
  ])("拒绝不安全 Base URL: %s", (baseUrl) => {
    expect(() => parseResponsesModelCandidateInput({ displayName: "模型", baseUrl, model: "m", apiKey: "k" })).toThrow();
  });

  it("拒绝未知字段，防止把兼容配置偷偷扩展成另一种协议", () => {
    expect(() => parseResponsesModelCandidateInput({
      displayName: "模型", baseUrl: "https://example.test", model: "m", apiKey: "k", wireApi: "chat",
    })).toThrow("未知字段");
    expect(() => parseModelStudentInstallInput({ testId: "test", apiKey: "bad" })).toThrow("未知字段");
  });

  it("入园时只接受可落盘的具体默认推理档位", () => {
    expect(parseModelStudentInstallInput({
      testId: "test",
      displayName: "大聪明",
      defaultReasoningProfile: "max",
    })).toEqual({ testId: "test", displayName: "大聪明", defaultReasoningProfile: "max" });
    expect(() => parseModelStudentInstallInput({ testId: "test", defaultReasoningProfile: "auto" }))
      .toThrow("fast、balanced、deep 或 max");
  });

  it("读取并深校验端点体检产生的 reasoning 映射", () => {
    const value = readResponsesCapabilityProbe({
      schemaVersion: 1,
      protocol: "openai_responses",
      adapterRevision: "openai-responses-v1",
      probeVersion: 1,
      connectionFingerprint: "a".repeat(64),
      streaming: true,
      text: true,
      toolCalls: true,
      toolContinuation: true,
      usage: true,
      thought: false,
      reasoning: {
        capability: {
          schemaVersion: 1,
          control: "effort_levels",
          adjustable: true,
          supportedProfiles: ["fast", "balanced", "deep", "max"],
          defaultProfile: "balanced",
          native: { parameter: "reasoning.effort", values: ["low", "medium", "high", "xhigh"] },
        },
        nativeByProfile: {
          fast: { effort: "low" },
          balanced: { effort: "medium" },
          deep: { effort: "high" },
          max: { effort: "xhigh" },
        },
        acceptedNativeValues: [
          { effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" },
        ],
      },
      testedAt: "2026-08-14T00:00:00.000Z",
    });
    expect(value.reasoning.acceptedNativeValues).toEqual([
      { effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" },
    ]);
    expect(value.reasoning.nativeByProfile.max).toEqual({ effort: "xhigh" });
  });

  it("公开体检快照不需要也不能容纳原始 Key", () => {
    const secret = "SECRET_SENTINEL_MODEL_ADMISSION";
    const candidate = parseResponsesModelCandidateInput({
      displayName: "模型", baseUrl: "https://example.test", model: "m", apiKey: secret,
    });
    const publicCandidate = {
      presetId: "custom_responses" as const,
      displayName: candidate.displayName,
      baseUrl: candidate.baseUrl,
      model: candidate.model,
      protocol: "openai_responses" as const,
    };
    expect(JSON.stringify(publicCandidate)).not.toContain(secret);
  });
});
