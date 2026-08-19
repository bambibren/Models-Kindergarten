import { describe, expect, it, vi } from "vitest";
import type { RuntimeCapabilityResolver } from "../../src/capability/runtime-capability-resolver.js";
import { ContextPreviewService } from "../../src/experiments/context-preview-service.js";
import { FixtureProvider } from "../../src/model/fixture-provider.js";

describe("ContextPreviewService V2", () => {
  it("用目标模型、推理档位和真实 Runtime 固定指令生成首轮预览", async () => {
    const fixture = new FixtureProvider();
    const policy = {
      systemPrompt: "Agent 可编辑基础指令",
      builtinTools: [], skillInstallationIds: [], mcps: [],
      historyPolicy: { mode: "recent_turns" as const, maxTurns: 6 },
      memoryPolicy: { mode: "off" as const },
    };
    const resolver = {
      preview: vi.fn(async () => ({
        model: fixture,
        agent: { systemPrompt: policy.systemPrompt },
        context: { buildObserved: vi.fn(async () => ({
          messages: [{ role: "user", content: "生成页面" }],
          observations: [], segments: [], truncatedSourceIds: [],
        })) },
        tools: { registry: { definitions: [] } },
        agentSnapshotHash: "agent-hash", capabilityHash: "capability-hash",
      })),
      modelSummary: vi.fn(() => ({
        schemaVersion: 1, modelStudentId: fixture.student.id, displayName: fixture.student.name,
        sizeClass: fixture.student.sizeClass, providerKind: fixture.student.provider.kind,
        model: fixture.student.provider.model, status: "ready", deletable: false,
        supports: { streaming: true, toolCalls: true, thought: true, usage: true,
          reasoning: fixture.reasoningCapability! },
      })),
    } as unknown as RuntimeCapabilityResolver;
    const service = new ContextPreviewService(resolver);
    const test = {
      testId: "test-a", label: "A" as const,
      sourceAgent: { agentId: "agent-1", name: "Agent", updatedAt: "2026-08-18T12:00:00.000Z" },
      modelStudentId: fixture.student.id, reasoningProfile: "auto" as const, policy,
    };
    const result = await service.preview({ schemaVersion: 2, promptText: "生成页面", test });

    expect(resolver.preview).toHaveBeenCalledWith("local-admin", policy, "生成页面", fixture.student.id);
    expect(result.schemaVersion).toBe(2);
    expect(result.contextSummary.items[0]?.raw?.value).toContain("【每轮响应契约】");
    expect(result.providerInput.value).toContain("【Skill 使用协议】");
    expect(result.resolvedReasoning).toMatchObject({ requestedProfile: "auto", resolvedProfile: "balanced" });
    expect(result.history).toEqual({ configuredPolicy: policy.historyPolicy, actualHistoryTurns: 0 });
    expect(result.runnable).toBe(true);
  });

  it("拒绝 sourceTurnId/history 输入，Turn 只允许作为实验来源追溯", async () => {
    const resolver = {} as RuntimeCapabilityResolver;
    const service = new ContextPreviewService(resolver);
    await expect(service.preview({
      schemaVersion: 2,
      promptText: "继续",
      sourceTurnId: "source-turn",
      test: {},
    })).rejects.toMatchObject({ status: 400, code: "VALIDATION_FAILED", retryable: false });
  });
});
