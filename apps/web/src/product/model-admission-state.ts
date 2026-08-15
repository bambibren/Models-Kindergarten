import type {
  ConcreteReasoningProfile,
  ModelProviderPresetId,
  ModelProviderPresetView,
  ModelStudentCandidateInput,
  ModelStudentInstallInput,
  ModelStudentTestRecord,
} from "@kindergarten/contracts";

export type ModelAdmissionPhase = "loading" | "editing" | "testing" | "verified" | "installing" | "failed";
export type ModelAdmissionField = "displayName" | "baseUrl" | "model" | "apiKey";
export type ModelAdmissionFieldErrors = Partial<Record<ModelAdmissionField, string>>;

export interface ModelAdmissionDraft {
  presetId: ModelProviderPresetId | "";
  displayName: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface ModelAdmissionViewState {
  phase: ModelAdmissionPhase;
  draft: ModelAdmissionDraft;
  fieldErrors: ModelAdmissionFieldErrors;
  defaultReasoningProfile?: ConcreteReasoningProfile;
  test?: ModelStudentTestRecord;
  error?: string;
}

export function createModelAdmissionState(): ModelAdmissionViewState {
  return {
    phase: "loading",
    draft: { presetId: "", displayName: "", baseUrl: "", model: "", apiKey: "" },
    fieldErrors: {},
  };
}

export function initializeModelAdmissionPresets(
  state: ModelAdmissionViewState,
  presets: ModelProviderPresetView[],
): ModelAdmissionViewState {
  const current = presets.find((item) => item.presetId === state.draft.presetId);
  const selected = current ?? presets[0];
  if (!selected) {
    return { ...state, phase: "failed", error: "当前没有可用的模型接入方式。" };
  }
  return {
    phase: "editing",
    draft: {
      ...state.draft,
      presetId: selected.presetId,
      baseUrl: selected.baseUrl.mode === "editable" ? selected.baseUrl.defaultValue ?? "" : "",
    },
    fieldErrors: {},
  };
}

/** 切换 Provider 会清空协议相关字段、Secret 和旧体检。 */
export function selectModelAdmissionPreset(
  state: ModelAdmissionViewState,
  preset: ModelProviderPresetView,
): ModelAdmissionViewState {
  return {
    phase: "editing",
    draft: {
      presetId: preset.presetId,
      displayName: state.draft.displayName,
      baseUrl: preset.baseUrl.mode === "editable" ? preset.baseUrl.defaultValue ?? "" : "",
      model: "",
      apiKey: "",
    },
    fieldErrors: {},
  };
}

/** 连接事实改变后，旧体检不能继续用于安装。 */
export function updateModelAdmissionConnection(
  state: ModelAdmissionViewState,
  patch: Partial<Pick<ModelAdmissionDraft, "baseUrl" | "model" | "apiKey">>,
): ModelAdmissionViewState {
  return {
    phase: "editing",
    draft: { ...state.draft, ...patch },
    fieldErrors: {},
  };
}

/** 昵称不参与 Provider 能力事实，体检通过后仍可改名。 */
export function updateModelAdmissionDisplayName(
  state: ModelAdmissionViewState,
  displayName: string,
): ModelAdmissionViewState {
  const { displayName: _ignored, ...fieldErrors } = state.fieldErrors;
  return { ...state, draft: { ...state.draft, displayName }, fieldErrors };
}

export function beginModelAdmissionTest(state: ModelAdmissionViewState): ModelAdmissionViewState {
  return {
    phase: "testing",
    draft: state.draft,
    fieldErrors: {},
  };
}

export function acceptSuccessfulModelStudentTest(
  state: ModelAdmissionViewState,
  test: ModelStudentTestRecord,
): ModelAdmissionViewState {
  if (test.state !== "succeeded" || !test.snapshot) {
    throw new Error("只有成功的模型体检才能进入待入园状态");
  }
  return {
    phase: "verified",
    draft: state.draft,
    fieldErrors: {},
    test,
    defaultReasoningProfile: test.snapshot.reasoning.capability.defaultProfile,
  };
}

export function updateModelAdmissionDefaultReasoningProfile(
  state: ModelAdmissionViewState,
  profile: ConcreteReasoningProfile,
): ModelAdmissionViewState {
  const supported = state.test?.snapshot?.reasoning.capability.supportedProfiles;
  return supported?.includes(profile) ? { ...state, defaultReasoningProfile: profile } : state;
}

export function buildModelStudentInstallInput(state: ModelAdmissionViewState): ModelStudentInstallInput {
  const snapshot = state.test?.snapshot;
  const profile = state.defaultReasoningProfile;
  if (state.test?.state !== "succeeded" || !snapshot || !profile || !snapshot.reasoning.capability.supportedProfiles.includes(profile)) {
    throw new Error("请先完成模型体检并选择模型默认思考设置");
  }
  return {
    testId: state.test.testId,
    displayName: state.draft.displayName.trim(),
    defaultReasoningProfile: profile,
  };
}

export function validateModelAdmissionDraft(
  draft: ModelAdmissionDraft,
  preset: ModelProviderPresetView | undefined,
): { valid: boolean; errors: ModelAdmissionFieldErrors } {
  const errors: ModelAdmissionFieldErrors = {};
  const name = draft.displayName.trim();
  const model = draft.model.trim();
  if (!preset || preset.presetId !== draft.presetId) return { valid: false, errors };
  if (!name) errors.displayName = "请给模型学生起一个名字。";
  else if (name.length > 80) errors.displayName = "名称不能超过 80 个字符。";
  if (!model) errors.model = "请输入上游模型 ID。";
  else if (model.length > 200) errors.model = "模型 ID 不能超过 200 个字符。";
  if (draft.apiKey.length === 0) errors.apiKey = "请输入 API Key。";
  else if (draft.apiKey.length > 8_192) errors.apiKey = "API Key 长度超过限制。";
  if (preset.baseUrl.mode === "editable") {
    try {
      const url = new URL(draft.baseUrl.trim());
      if (url.protocol !== "https:") errors.baseUrl = "自定义云端接口必须使用 HTTPS。";
      else if (url.username || url.password) errors.baseUrl = "Base URL 不能包含用户名或密码。";
      else if (url.search || url.hash) errors.baseUrl = "Base URL 不能包含查询参数或片段。";
    } catch {
      errors.baseUrl = "请输入完整有效的 HTTPS Base URL。";
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export function buildModelStudentCandidate(
  draft: ModelAdmissionDraft,
  preset: ModelProviderPresetView,
): ModelStudentCandidateInput {
  const common = {
    presetId: preset.presetId,
    displayName: draft.displayName.trim(),
    model: draft.model.trim(),
    apiKey: draft.apiKey,
  };
  if (preset.presetId === "custom_responses") {
    return { ...common, presetId: "custom_responses", baseUrl: draft.baseUrl.trim() };
  }
  if (preset.presetId === "openai") return { ...common, presetId: "openai" };
  if (preset.presetId === "siliconflow") return { ...common, presetId: "siliconflow" };
  throw new Error("当前模型接入方式尚未开放");
}

export function visibleModelAdmissionErrors(
  draft: ModelAdmissionDraft,
  validationErrors: ModelAdmissionFieldErrors,
  serverErrors: ModelAdmissionFieldErrors,
): ModelAdmissionFieldErrors {
  const visible: ModelAdmissionFieldErrors = {};
  for (const field of ["displayName", "baseUrl", "model", "apiKey"] as const) {
    if (draft[field].length > 0 && validationErrors[field]) visible[field] = validationErrors[field];
    if (serverErrors[field]) visible[field] = serverErrors[field];
  }
  return visible;
}

export function selectedModelProviderPreset(
  presets: ModelProviderPresetView[],
  presetId: ModelAdmissionDraft["presetId"],
): ModelProviderPresetView | undefined {
  return presets.find((item) => item.presetId === presetId);
}

export function modelStudentHomeUrl(modelStudentId: string): string {
  return `/?modelStudentId=${encodeURIComponent(modelStudentId)}`;
}
