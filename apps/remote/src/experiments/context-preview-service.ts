import type { ContextPreviewInput, ContextPreviewResponse } from "@kindergarten/contracts";
import { buildContextSummary, serializeModelInput } from "../runtime/agent-runtime.js";
import type { RuntimeCapabilityResolver } from "../capability/runtime-capability-resolver.js";
import type { SessionRepository } from "../repository/session-repository.js";
import { ApiProblemError } from "../server/api-problem.js";

export class ContextPreviewService {
  constructor(private readonly resolver: RuntimeCapabilityResolver, private readonly sessions: SessionRepository) {}

  async preview(raw: unknown, ownerId = "local-admin"): Promise<ContextPreviewResponse> {
    const input = parse(raw);
    const resolved = await this.resolver.preview(ownerId, input.policy, input.promptText);
    if (resolved.model.student.id !== input.modelStudentId) throw new ApiProblemError(409, "EXPERIMENT_NOT_RUNNABLE", "ModelStudent 不可用", false);
    const entries = input.sourceTurnId
      ? await this.sourceEntries(input.sourceTurnId, ownerId, input.modelStudentId)
      : [];
    const built = await resolved.context.buildObserved(entries, input.promptText, new AbortController().signal);
    const tools = structuredClone(resolved.tools.registry.definitions);
    const contextSummary = buildContextSummary("context-preview", resolved.model, resolved.agent.systemPrompt, tools, built);
    return {
      schemaVersion: 1,
      agentSnapshotHash: resolved.agentSnapshotHash,
      capabilityHash: resolved.capabilityHash,
      contextSummary,
      providerInput: serializeModelInput(resolved.model, { systemPrompt: resolved.agent.systemPrompt, messages: built.messages, tools }),
    };
  }

  private async sourceEntries(turnId: string, ownerId: string, targetModelStudentId: string) {
    for (const session of await this.sessions.allForRuntime("chat")) {
      if (session.ownerId !== ownerId) continue;
      if (session.turns.some((item) => item.turnId === turnId && item.state.status === "completed")) {
        if (session.modelStudentId !== targetModelStudentId) {
          throw new ApiProblemError(
            409,
            "EXPERIMENT_NOT_RUNNABLE",
            "历史 Turn 与上下文预览必须绑定同一个 ModelStudent",
            false,
            [{ path: "modelStudentId", message: "必须与 sourceTurnId 所属 Session 的 modelStudentId 一致" }],
          );
        }
        const start = session.sessionEntries.findIndex((entry) => entry.turnId === turnId);
        return structuredClone(start < 0 ? session.sessionEntries : session.sessionEntries.slice(0, start));
      }
    }
    throw new ApiProblemError(404, "TURN_SNAPSHOT_UNAVAILABLE", "历史 Turn 不存在或未完成", false);
  }
}

function parse(value: unknown): ContextPreviewInput {
  if (!record(value) || typeof value.modelStudentId !== "string" || typeof value.promptText !== "string" || !record(value.policy)) throw invalid();
  return {
    modelStudentId: value.modelStudentId,
    promptText: value.promptText,
    policy: value.policy as unknown as ContextPreviewInput["policy"],
    ...(typeof value.sourceTurnId === "string" && value.sourceTurnId ? { sourceTurnId: value.sourceTurnId } : {}),
  };
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function invalid() { return new ApiProblemError(400, "VALIDATION_FAILED", "Context Preview 输入无效", false); }
