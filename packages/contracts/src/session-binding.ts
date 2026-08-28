import { isRecord, META_KEY } from "./common.js";

/** 描述「SessionBinding」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SessionBinding {
  schemaVersion: 1;
  modelStudentId: string;
  agentId: string;
}

/** 描述「SessionBindingMeta」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SessionBindingMeta {
  schemaVersion: 1;
  binding: SessionBinding;
}

/** 描述「ExperimentRunRefMeta」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExperimentRunRefMeta {
  schemaVersion: 1;
  experimentId: string;
  variantId: string;
}

/** 根据已校验输入构建「makeSessionBindingMeta」结果，不额外持有调用方的大对象。 */
export function makeSessionBindingMeta(binding: SessionBinding): Record<string, unknown> {
  return { [META_KEY]: { sessionBinding: { schemaVersion: 1, binding } } };
}

/** 根据已校验输入构建「makeExperimentRunRefMeta」结果，不额外持有调用方的大对象。 */
export function makeExperimentRunRefMeta(experimentId: string, variantId: string): Record<string, unknown> {
  return { [META_KEY]: { experimentRunRef: { schemaVersion: 1, experimentId, variantId } } };
}

/** 读取「readSessionBindingMeta」所需数据，并遵守作用域、分页与容量边界。 */
export function readSessionBindingMeta(value: unknown): SessionBindingMeta | undefined {
  if (!isRecord(value) || !isRecord(value[META_KEY])) return undefined;
  const meta = value[META_KEY].sessionBinding;
  if (!isRecord(meta) || meta.schemaVersion !== 1 || !isRecord(meta.binding)) return undefined;
  const binding = meta.binding;
  if (binding.schemaVersion !== 1 || !nonEmpty(binding.modelStudentId) || !nonEmpty(binding.agentId)) return undefined;
  return {
    schemaVersion: 1,
    binding: { schemaVersion: 1, modelStudentId: binding.modelStudentId, agentId: binding.agentId },
  };
}

/** 读取「readExperimentRunRefMeta」所需数据，并遵守作用域、分页与容量边界。 */
export function readExperimentRunRefMeta(value: unknown): ExperimentRunRefMeta | undefined {
  if (!isRecord(value) || !isRecord(value[META_KEY])) return undefined;
  const meta = value[META_KEY].experimentRunRef;
  if (!isRecord(meta) || meta.schemaVersion !== 1 || !nonEmpty(meta.experimentId) || !nonEmpty(meta.variantId)) return undefined;
  return { schemaVersion: 1, experimentId: meta.experimentId, variantId: meta.variantId };
}

/** 执行「nonEmpty」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
