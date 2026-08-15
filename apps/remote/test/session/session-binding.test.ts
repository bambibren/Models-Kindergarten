import { makeExperimentRunRefMeta, makeSessionBindingMeta } from "@kindergarten/contracts";
import { describe, expect, it } from "vitest";
import { SessionBindingService } from "../../src/session/session-binding-service.js";

describe("SessionBindingService", () => {
  const service = new SessionBindingService({
    workspaceCwd: "/workspace",
    agentExists: async (id) => id === "agent-1",
    modelStudentReady: (id) => id === "student-1",
    experimentBinding: async (experimentId, variantId) => experimentId === "experiment-1" && variantId === "b"
      ? { modelStudentId: "student-1", agentId: "agent-1" }
      : undefined,
  });

  it("chat session/new 必须带有效 binding", async () => {
    await expect(service.resolve({ cwd: "/workspace", mcpServers: [] })).rejects.toThrow("SESSION_BINDING_INVALID");
    await expect(service.resolve({
      cwd: "/workspace", mcpServers: [], _meta: makeSessionBindingMeta({ schemaVersion: 1, modelStudentId: "student-1", agentId: "agent-1" }),
    })).resolves.toMatchObject({ purpose: "chat", modelStudentId: "student-1", agentId: "agent-1" });
  });

  it("拒绝 Browser 临时 MCP、未知 Agent 和越界 workspace", async () => {
    const validMeta = makeSessionBindingMeta({ schemaVersion: 1, modelStudentId: "student-1", agentId: "agent-1" });
    await expect(service.resolve({ cwd: "/workspace", mcpServers: [{ name: "x" }], _meta: validMeta })).rejects.toThrow("mcpServers");
    await expect(service.resolve({ cwd: "/other", mcpServers: [], _meta: validMeta })).rejects.toThrow("cwd");
    await expect(service.resolve({
      cwd: "/workspace", mcpServers: [], _meta: makeSessionBindingMeta({ schemaVersion: 1, modelStudentId: "student-1", agentId: "missing" }),
    })).rejects.toThrow("Agent");
  });

  it("experiment ref 只从服务端实验事实派生绑定", async () => {
    await expect(service.resolve({
      cwd: "/workspace", mcpServers: [], _meta: makeExperimentRunRefMeta("experiment-1", "b"),
    })).resolves.toMatchObject({
      purpose: "experiment",
      modelStudentId: "student-1",
      agentId: "agent-1",
      experimentRef: { experimentId: "experiment-1", variantId: "b" },
    });
  });
});
