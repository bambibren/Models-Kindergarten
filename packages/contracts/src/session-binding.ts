import { isRecord, META_KEY } from "./common.js";

export interface SessionBinding {
  schemaVersion: 1;
  modelStudentId: string;
  agentId: string;
}

export interface SessionBindingMeta {
  schemaVersion: 1;
  binding: SessionBinding;
}

export interface ExperimentRunRefMeta {
  schemaVersion: 1;
  experimentId: string;
  variantId: string;
}

export function makeSessionBindingMeta(binding: SessionBinding): Record<string, unknown> {
  return { [META_KEY]: { sessionBinding: { schemaVersion: 1, binding } } };
}

export function makeExperimentRunRefMeta(experimentId: string, variantId: string): Record<string, unknown> {
  return { [META_KEY]: { experimentRunRef: { schemaVersion: 1, experimentId, variantId } } };
}

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

export function readExperimentRunRefMeta(value: unknown): ExperimentRunRefMeta | undefined {
  if (!isRecord(value) || !isRecord(value[META_KEY])) return undefined;
  const meta = value[META_KEY].experimentRunRef;
  if (!isRecord(meta) || meta.schemaVersion !== 1 || !nonEmpty(meta.experimentId) || !nonEmpty(meta.variantId)) return undefined;
  return { schemaVersion: 1, experimentId: meta.experimentId, variantId: meta.variantId };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
