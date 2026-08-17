import { describe, expect, it } from "vitest";
import type {
  ModelProviderPresetView,
  ModelStudentSummary,
  ModelStudentTestRecord,
} from "@kindergarten/contracts";
import { selectInitialModelStudentId } from "./HomePage.js";
import {
  acceptSuccessfulModelStudentTest,
  beginModelAdmissionTest,
  buildModelStudentInstallInput,
  buildModelStudentCandidate,
  createModelAdmissionState,
  initializeModelAdmissionPresets,
  modelStudentHomeUrl,
  selectModelAdmissionPreset,
  updateModelAdmissionConnection,
  updateModelAdmissionContextWindowTokens,
  updateModelAdmissionDefaultReasoningProfile,
  updateModelAdmissionDisplayName,
  validateOptionalContextWindowTokens,
  validateModelAdmissionDraft,
  visibleModelAdmissionErrors,
} from "./model-admission-state.js";

const openaiPreset: ModelProviderPresetView = {
  schemaVersion: 1,
  presetId: "openai",
  displayName: "OpenAI 官方",
  description: "官方 Responses API",
  protocol: "openai_responses",
  availability: "ready",
  baseUrl: { mode: "fixed", value: "https://api.openai.com/v1" },
  auth: { scheme: "bearer", apiKeyLabel: "OpenAI API Key" },
  modelEntry: "discoverable",
};

const customPreset: ModelProviderPresetView = {
  schemaVersion: 1,
  presetId: "custom_responses",
  displayName: "自定义 Responses",
  description: "自定义 Responses-compatible 地址",
  protocol: "openai_responses",
  availability: "ready",
  baseUrl: { mode: "editable" },
  auth: { scheme: "bearer", apiKeyLabel: "API Key" },
  modelEntry: "manual",
};

const siliconflowPreset: ModelProviderPresetView = {
  schemaVersion: 1,
  presetId: "siliconflow",
  displayName: "硅基流动",
  description: "官方 Chat Completions API",
  protocol: "openai_chat_completions",
  availability: "ready",
  baseUrl: { mode: "fixed", value: "https://api.siliconflow.cn/v1" },
  auth: { scheme: "bearer", apiKeyLabel: "SiliconFlow API Key" },
  modelEntry: "discoverable",
};

const successfulTest: ModelStudentTestRecord = {
  schemaVersion: 1,
  testId: "test-1",
  ownerId: "local-admin",
  candidate: {
    presetId: "custom_responses",
    displayName: "大聪明",
    baseUrl: "https://responses.example.test",
    model: "same-model-id",
    protocol: "openai_responses",
  },
  state: "succeeded",
  snapshot: {
    schemaVersion: 1,
    protocol: "openai_responses",
    adapterRevision: "responses-v1",
    probeVersion: 1,
    connectionFingerprint: "public-fingerprint",
    streaming: true,
    text: true,
    toolCalls: true,
    toolContinuation: true,
    usage: true,
    thought: true,
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
        fast: { "reasoning.effort": "low" },
        balanced: { "reasoning.effort": "medium" },
        deep: { "reasoning.effort": "high" },
        max: { "reasoning.effort": "xhigh" },
      },
      acceptedNativeValues: [
        { "reasoning.effort": "low" },
        { "reasoning.effort": "medium" },
        { "reasoning.effort": "high" },
        { "reasoning.effort": "xhigh" },
      ],
    },
    testedAt: "2026-08-14T08:00:00.000Z",
  },
  createdAt: "2026-08-14T08:00:00.000Z",
  expiresAt: "2026-08-14T08:10:00.000Z",
};

describe("production model admission state", () => {
  it("uses the ready presets returned by Remote instead of a Web-owned provider list", () => {
    const initialized = initializeModelAdmissionPresets(createModelAdmissionState(), [siliconflowPreset, openaiPreset]);
    expect(initialized.phase).toBe("editing");
    expect(initialized.draft.presetId).toBe("siliconflow");
    expect(initialized.draft.contextWindowTokens).toBe("");
  });

  it("accepts an opaque credential without assuming an sk- prefix", () => {
    expect(validateModelAdmissionDraft({
      presetId: "custom_responses",
      displayName: "大聪明",
      baseUrl: "https://sub.example.test",
      model: "custom-model",
      apiKey: "opaque-provider-key",
      contextWindowTokens: "",
    }, customPreset)).toEqual({ valid: true, errors: {} });
  });

  it("rejects unsafe custom URLs but never asks for Base URL on fixed presets", () => {
    expect(validateModelAdmissionDraft({
      presetId: "custom_responses",
      displayName: "",
      baseUrl: "http://user:pass@example.test?key=value",
      model: "",
      apiKey: "",
      contextWindowTokens: "",
    }, customPreset)).toMatchObject({
      valid: false,
      errors: {
        displayName: expect.any(String),
        baseUrl: "自定义云端接口必须使用 HTTPS。",
        model: expect.any(String),
        apiKey: expect.any(String),
      },
    });
    expect(validateModelAdmissionDraft({
      presetId: "openai",
      displayName: "官方学生",
      baseUrl: "",
      model: "provider-model-id",
      apiKey: "opaque",
      contextWindowTokens: "",
    }, openaiPreset)).toEqual({ valid: true, errors: {} });
  });

  it("never sends a browser-supplied Base URL for fixed presets", () => {
    const input = buildModelStudentCandidate({
      presetId: "openai",
      displayName: "官方学生",
      baseUrl: "https://attacker.invalid",
      model: "provider-model-id",
      apiKey: "opaque",
      contextWindowTokens: "262144",
    }, openaiPreset);
    expect(input).toEqual({
      presetId: "openai",
      displayName: "官方学生",
      model: "provider-model-id",
      apiKey: "opaque",
    });
    expect("baseUrl" in input).toBe(false);
    expect("contextWindowTokens" in input).toBe(false);
  });

  it("invalidates a verified probe when connection facts change", () => {
    const verified = {
      ...initializeModelAdmissionPresets(createModelAdmissionState(), [customPreset]),
      phase: "verified" as const,
      draft: { presetId: "custom_responses" as const, displayName: "大聪明", baseUrl: "https://responses.example.test", model: "same-model-id", apiKey: "secret", contextWindowTokens: "262144" },
      test: successfulTest,
    };
    for (const patch of [
      { model: "another-model" },
      { apiKey: "another-secret" },
      { baseUrl: "https://another.example.test" },
    ]) {
      const changed = updateModelAdmissionConnection(verified, patch);
      expect(changed.phase).toBe("editing");
      expect(changed.test).toBeUndefined();
      expect(changed.defaultReasoningProfile).toBeUndefined();
      expect(changed.draft).toMatchObject(patch);
      expect(changed.draft.contextWindowTokens).toBe("262144");
    }
  });

  it("clears protocol-specific fields and secret when the preset changes", () => {
    const current = {
      ...initializeModelAdmissionPresets(createModelAdmissionState(), [customPreset]),
      draft: { presetId: "custom_responses" as const, displayName: "大聪明", baseUrl: "https://custom.example", model: "model-a", apiKey: "secret", contextWindowTokens: "262144" },
      test: successfulTest,
    };
    const changed = selectModelAdmissionPreset(current, siliconflowPreset);
    expect(changed.draft).toEqual({ presetId: "siliconflow", displayName: "大聪明", baseUrl: "", model: "", apiKey: "", contextWindowTokens: "262144" });
    expect(changed.test).toBeUndefined();
  });

  it("keeps a verified probe when only the ModelStudent nickname changes", () => {
    const editing = {
      ...initializeModelAdmissionPresets(createModelAdmissionState(), [customPreset]),
      draft: { presetId: "custom_responses" as const, displayName: "原名", baseUrl: "https://responses.example.test", model: "same-model-id", apiKey: "secret", contextWindowTokens: "262144" },
    };
    const verified = acceptSuccessfulModelStudentTest(editing, successfulTest);
    const selected = updateModelAdmissionDefaultReasoningProfile(verified, "max");
    const renamed = updateModelAdmissionDisplayName(selected, "大聪明");
    expect(renamed.phase).toBe("verified");
    expect(renamed.test?.testId).toBe("test-1");
    expect(renamed.draft.displayName).toBe("大聪明");
    expect(renamed.defaultReasoningProfile).toBe("max");
    expect(buildModelStudentInstallInput(renamed)).toEqual({
      testId: "test-1",
      displayName: "大聪明",
      defaultReasoningProfile: "max",
      contextWindowTokens: 262_144,
    });
  });

  it("keeps a verified probe when the optional context window changes", () => {
    const editing = {
      ...initializeModelAdmissionPresets(createModelAdmissionState(), [customPreset]),
      draft: {
        presetId: "custom_responses" as const,
        displayName: "大聪明",
        baseUrl: "https://responses.example.test",
        model: "same-model-id",
        apiKey: "secret",
        contextWindowTokens: "",
      },
    };
    const verified = updateModelAdmissionDefaultReasoningProfile(
      acceptSuccessfulModelStudentTest(editing, successfulTest),
      "max",
    );
    const updated = updateModelAdmissionContextWindowTokens(verified, "262144");

    expect(updated.phase).toBe("verified");
    expect(updated.test?.testId).toBe("test-1");
    expect(updated.defaultReasoningProfile).toBe("max");
    expect(updated.draft.contextWindowTokens).toBe("262144");
  });

  it("omits a blank context window and rejects a provided non-positive integer", () => {
    const editing = updateModelAdmissionDisplayName(
      initializeModelAdmissionPresets(createModelAdmissionState(), [customPreset]),
      "大聪明",
    );
    const verified = acceptSuccessfulModelStudentTest(editing, successfulTest);
    expect(buildModelStudentInstallInput(verified)).toEqual({
      testId: "test-1",
      displayName: "大聪明",
      defaultReasoningProfile: "balanced",
    });

    for (const value of ["0", "-1", "1.5", "9007199254740992"]) {
      const invalid = updateModelAdmissionContextWindowTokens(verified, value);
      expect(() => buildModelStudentInstallInput(invalid)).toThrow("上下文窗口必须是正整数，或留空");
    }
  });

  it("validates the optional context window independently from capability probing", () => {
    expect(validateOptionalContextWindowTokens("")).toBeUndefined();
    expect(validateOptionalContextWindowTokens(" 262144 ")).toBeUndefined();
    expect(validateOptionalContextWindowTokens("0")).toBe("请输入正整数，或留空。");
    expect(validateOptionalContextWindowTokens("1.5")).toBe("请输入正整数，或留空。");

    const draft = {
      presetId: "custom_responses" as const,
      displayName: "大聪明",
      baseUrl: "https://responses.example.test",
      model: "same-model-id",
      apiKey: "secret",
      contextWindowTokens: "1.5",
    };
    expect(validateModelAdmissionDraft(draft, customPreset)).toEqual({ valid: true, errors: {} });
    const contextWindowError = validateOptionalContextWindowTokens(draft.contextWindowTokens);
    expect(visibleModelAdmissionErrors(draft, {
      contextWindowTokens: contextWindowError!,
    }, {})).toEqual({ contextWindowTokens: "请输入正整数，或留空。" });
  });

  it("starts from the probe default and resets the selection before every new probe", () => {
    const editing = initializeModelAdmissionPresets(createModelAdmissionState(), [customPreset]);
    const verified = acceptSuccessfulModelStudentTest(editing, successfulTest);
    expect(verified.defaultReasoningProfile).toBe("balanced");
    expect(updateModelAdmissionDefaultReasoningProfile(verified, "deep").defaultReasoningProfile).toBe("deep");
    expect(updateModelAdmissionDefaultReasoningProfile(verified, "fast").defaultReasoningProfile).toBe("fast");
    const testing = beginModelAdmissionTest(verified);
    expect(testing.defaultReasoningProfile).toBeUndefined();
    const nextTest: ModelStudentTestRecord = {
      ...successfulTest,
      testId: "test-2",
      snapshot: {
        ...successfulTest.snapshot!,
        reasoning: {
          ...successfulTest.snapshot!.reasoning,
          capability: {
            ...successfulTest.snapshot!.reasoning.capability,
            defaultProfile: "deep",
          },
        },
      },
    };
    expect(acceptSuccessfulModelStudentTest(testing, nextTest).defaultReasoningProfile).toBe("deep");
  });

  it("shows validation errors only after a field contains an invalid value", () => {
    const empty = initializeModelAdmissionPresets(createModelAdmissionState(), [customPreset]).draft;
    const emptyValidation = validateModelAdmissionDraft(empty, customPreset);
    expect(visibleModelAdmissionErrors(empty, emptyValidation.errors, {})).toEqual({});
    const typed = { ...empty, baseUrl: "not-a-url" };
    expect(visibleModelAdmissionErrors(typed, validateModelAdmissionDraft(typed, customPreset).errors, {})).toEqual({
      baseUrl: "请输入完整有效的 HTTPS Base URL。",
    });
  });

  it("returns to Home with only the new public ModelStudent id in the URL", () => {
    const url = modelStudentHomeUrl("student/大聪明");
    expect(url).toBe("/?modelStudentId=student%2F%E5%A4%A7%E8%81%AA%E6%98%8E");
    expect(url).not.toContain("secret");
  });

  it("preselects the admitted model from the Home query and safely falls back", () => {
    const models = [model("local"), model("managed")];
    expect(selectInitialModelStudentId(models, "?modelStudentId=managed")).toBe("managed");
    expect(selectInitialModelStudentId(models, "?modelStudentId=missing")).toBe("local");
  });
});

function model(modelStudentId: string): ModelStudentSummary {
  return {
    schemaVersion: 1,
    modelStudentId,
    displayName: modelStudentId,
    sizeClass: "large",
    providerKind: "openai-compatible",
    model: "same-model-id",
    status: "ready",
    supports: {
      streaming: true,
      toolCalls: true,
      thought: true,
      usage: true,
      reasoning: {
        schemaVersion: 1,
        control: "effort_levels",
        adjustable: true,
        supportedProfiles: ["balanced", "max"],
        defaultProfile: "balanced",
      },
    },
  };
}
