import { describe, expect, it } from "vitest";
import {
  parseModelStudentInstallInput,
  parseModelStudentCandidateInput,
  parseResponsesModelCandidateInput,
  readResponsesCapabilityProbe,
} from "./model-admission.js";

describe("自定义 Responses 模型入园合同", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("接受无 API Key 的本机 Ollama 入园配置", () => {
    expect(parseModelStudentCandidateInput({
      presetId: "ollama",
      displayName: "本机千问",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:8b",
    })).toEqual({
      presetId: "ollama",
      displayName: "本机千问",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:8b",
    });
  });

  it("拒绝 Ollama 借可编辑地址访问局域网", () => {
    expect(() => parseModelStudentCandidateInput({
      presetId: "ollama",
      displayName: "局域网模型",
      baseUrl: "http://192.168.1.10:11434",
      model: "qwen3:8b",
    })).toThrow("只允许");
  });

  it("规范化 HTTPS Base URL 并保留瞬时 API Key", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
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

  it("固定 Provider 预设不接受浏览器覆盖 Base URL", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(parseModelStudentCandidateInput({
      presetId: "openai", displayName: "官方模型", model: "gpt-5", apiKey: "k",
    })).toEqual({ presetId: "openai", displayName: "官方模型", model: "gpt-5", apiKey: "k" });
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => parseModelStudentCandidateInput({
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
  ])("拒绝不安全 Base URL: %s", /** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(baseUrl) => {
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => parseResponsesModelCandidateInput({ displayName: "模型", baseUrl, model: "m", apiKey: "k" })).toThrow();
  });

  it("拒绝未知字段，防止把兼容配置偷偷扩展成另一种协议", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => parseResponsesModelCandidateInput({
      displayName: "模型", baseUrl: "https://example.test", model: "m", apiKey: "k", wireApi: "chat",
    })).toThrow("未知字段");
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => parseModelStudentInstallInput({ testId: "test", apiKey: "bad" })).toThrow("未知字段");
  });

  it("入园时只接受可落盘的具体默认推理档位", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(parseModelStudentInstallInput({
      testId: "test",
      displayName: "大聪明",
      defaultReasoningProfile: "max",
      contextWindowTokens: 262_144,
    })).toEqual({
      testId: "test",
      displayName: "大聪明",
      defaultReasoningProfile: "max",
      contextWindowTokens: 262_144,
    });
    expect(parseModelStudentInstallInput({ testId: "test" })).toEqual({ testId: "test" });
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => parseModelStudentInstallInput({ testId: "test", defaultReasoningProfile: "auto" }))
      .toThrow("fast、balanced、deep 或 max");
  });

  it.each([0, -1, 1.5, "262144", Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "拒绝非正整数上下文上限: %s",
    /** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(contextWindowTokens) => {
      expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => parseModelStudentInstallInput({ testId: "test", contextWindowTokens }))
        .toThrow("contextWindowTokens 必须是正整数");
    },
  );

  it("读取并深校验端点体检产生的 reasoning 映射", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
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

  it("公开体检快照不需要也不能容纳原始 Key", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
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
