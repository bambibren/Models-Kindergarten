import type {
  ConcreteReasoningProfile,
  ModelProviderPresetId,
  ModelProviderPresetView,
  ModelStudentCandidateInput,
  ModelStudentInstallInput,
  ModelStudentTestRecord,
} from "@kindergarten/contracts";

/** 描述「ModelAdmissionPhase」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ModelAdmissionPhase = "loading" | "editing" | "testing" | "verified" | "installing" | "failed";
/** 描述「ModelAdmissionField」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ModelAdmissionField = "displayName" | "baseUrl" | "model" | "apiKey" | "contextWindowTokens";
/** 描述「ModelAdmissionFieldErrors」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ModelAdmissionFieldErrors = Partial<Record<ModelAdmissionField, string>>;

/** 描述「ModelAdmissionDraft」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelAdmissionDraft {
  presetId: ModelProviderPresetId | "";
  displayName: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  contextWindowTokens: string;
}

/** 描述「ModelAdmissionViewState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelAdmissionViewState {
  phase: ModelAdmissionPhase;
  draft: ModelAdmissionDraft;
  fieldErrors: ModelAdmissionFieldErrors;
  defaultReasoningProfile?: ConcreteReasoningProfile;
  test?: ModelStudentTestRecord;
  error?: string;
}

/** 根据已校验输入构建「createModelAdmissionState」结果，不额外持有调用方的大对象。 */
export function createModelAdmissionState(): ModelAdmissionViewState {
  return {
    phase: "loading",
    draft: { presetId: "", displayName: "", baseUrl: "", model: "", apiKey: "", contextWindowTokens: "" },
    fieldErrors: {},
  };
}

/** 执行「initializeModelAdmissionPresets」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function initializeModelAdmissionPresets(
  state: ModelAdmissionViewState,
  presets: ModelProviderPresetView[],
): ModelAdmissionViewState {
  const current = presets.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.presetId === state.draft.presetId);
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
      contextWindowTokens: state.draft.contextWindowTokens,
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

/** 上下文窗口是用户独立填写的展示数据，不参与连接事实或能力体检。 */
export function updateModelAdmissionContextWindowTokens(
  state: ModelAdmissionViewState,
  contextWindowTokens: string,
): ModelAdmissionViewState {
  const { contextWindowTokens: _ignored, ...fieldErrors } = state.fieldErrors;
  return { ...state, draft: { ...state.draft, contextWindowTokens }, fieldErrors };
}

/** 执行「beginModelAdmissionTest」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function beginModelAdmissionTest(state: ModelAdmissionViewState): ModelAdmissionViewState {
  return {
    phase: "testing",
    draft: state.draft,
    fieldErrors: {},
  };
}

/** 处理「acceptSuccessfulModelStudentTest」事件，校验归属后再推进状态且避免重复提交。 */
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

/** 更新「updateModelAdmissionDefaultReasoningProfile」对应状态，并保持写入顺序、原子性与容量约束。 */
export function updateModelAdmissionDefaultReasoningProfile(
  state: ModelAdmissionViewState,
  profile: ConcreteReasoningProfile,
): ModelAdmissionViewState {
  const supported = state.test?.snapshot?.reasoning.capability.supportedProfiles;
  return supported?.includes(profile) ? { ...state, defaultReasoningProfile: profile } : state;
}

/** 根据已校验输入构建「buildModelStudentInstallInput」结果，不额外持有调用方的大对象。 */
export function buildModelStudentInstallInput(state: ModelAdmissionViewState): ModelStudentInstallInput {
  const snapshot = state.test?.snapshot;
  const profile = state.defaultReasoningProfile;
  if (state.test?.state !== "succeeded" || !snapshot || !profile || !snapshot.reasoning.capability.supportedProfiles.includes(profile)) {
    throw new Error("请先完成模型体检并选择模型默认思考设置");
  }
  const contextWindowTokens = parseOptionalContextWindowTokens(state.draft.contextWindowTokens);
  return {
    testId: state.test.testId,
    displayName: state.draft.displayName.trim(),
    defaultReasoningProfile: profile,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
  };
}

/** 校验并规范化「validateOptionalContextWindowTokens」输入，非法数据直接返回明确错误。 */
export function validateOptionalContextWindowTokens(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? undefined : "请输入正整数，或留空。";
}

/** 校验并规范化「validateModelAdmissionDraft」输入，非法数据直接返回明确错误。 */
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
  if (preset.auth.scheme !== "none") {
    if (draft.apiKey.length === 0) errors.apiKey = "请输入 API Key。";
    else if (draft.apiKey.length > 8_192) errors.apiKey = "API Key 长度超过限制。";
  }
  if (preset.baseUrl.mode === "editable") {
    try {
      const url = new URL(draft.baseUrl.trim());
      if (preset.presetId === "ollama") {
        const hostname = url.hostname.toLowerCase();
        if (url.protocol !== "http:" && url.protocol !== "https:") errors.baseUrl = "本机 Ollama 必须使用 HTTP 或 HTTPS。";
        else if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)) errors.baseUrl = "本机 Ollama 只允许回环地址。";
      } else if (url.protocol !== "https:") errors.baseUrl = "自定义云端接口必须使用 HTTPS。";
      else if (url.username || url.password) errors.baseUrl = "Base URL 不能包含用户名或密码。";
      else if (url.search || url.hash) errors.baseUrl = "Base URL 不能包含查询参数或片段。";
    } catch {
      errors.baseUrl = "请输入完整有效的 HTTPS Base URL。";
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/** 根据已校验输入构建「buildModelStudentCandidate」结果，不额外持有调用方的大对象。 */
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
  if (preset.presetId === "ollama") {
    return {
      presetId: "ollama",
      displayName: common.displayName,
      model: common.model,
      baseUrl: draft.baseUrl.trim(),
    };
  }
  if (preset.presetId === "openai") return { ...common, presetId: "openai" };
  if (preset.presetId === "siliconflow") return { ...common, presetId: "siliconflow" };
  throw new Error("当前模型接入方式尚未开放");
}

/** 执行「visibleModelAdmissionErrors」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function visibleModelAdmissionErrors(
  draft: ModelAdmissionDraft,
  validationErrors: ModelAdmissionFieldErrors,
  serverErrors: ModelAdmissionFieldErrors,
): ModelAdmissionFieldErrors {
  const visible: ModelAdmissionFieldErrors = {};
  for (const field of ["displayName", "baseUrl", "model", "apiKey", "contextWindowTokens"] as const) {
    if (draft[field].length > 0 && validationErrors[field]) visible[field] = validationErrors[field];
    if (serverErrors[field]) visible[field] = serverErrors[field];
  }
  return visible;
}

/** 校验并规范化「parseOptionalContextWindowTokens」输入，非法数据直接返回明确错误。 */
function parseOptionalContextWindowTokens(value: string): number | undefined {
  const error = validateOptionalContextWindowTokens(value);
  if (error) throw new Error("上下文窗口必须是正整数，或留空。");
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : Number(trimmed);
}

/** 执行「selectedModelProviderPreset」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function selectedModelProviderPreset(
  presets: ModelProviderPresetView[],
  presetId: ModelAdmissionDraft["presetId"],
): ModelProviderPresetView | undefined {
  return presets.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.presetId === presetId);
}

/** 执行「modelStudentHomeUrl」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function modelStudentHomeUrl(modelStudentId: string): string {
  return `/?modelStudentId=${encodeURIComponent(modelStudentId)}`;
}
