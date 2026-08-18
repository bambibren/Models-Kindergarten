import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { makePromptMeta, makeSessionBindingMeta, readMessageMeta } from "@kindergarten/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { KindergartenAgent } from "../../src/acp/kindergarten-agent.js";
import { ArtifactBlobStore } from "../../src/artifacts/artifact-blob-store.js";
import { ArtifactRepository } from "../../src/artifacts/artifact-repository.js";
import { ArtifactService } from "../../src/artifacts/artifact-service.js";
import { FixtureProvider } from "../../src/model/fixture-provider.js";
import type { ModelInput } from "../../src/model/model-provider.js";
import { SessionRepository } from "../../src/repository/session-repository.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { SessionBindingService } from "../../src/session/session-binding-service.js";
import { FileSandbox } from "../../src/tools/sandbox.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("Artifact Mention ACP", () => {
  it("校验 owner 后写入 Session、模型上下文和 load 回放 Meta", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-artifact-mention-"));
    dirs.push(dir);
    const workspaces = join(dir, "workspaces");
    const artifacts = new ArtifactService(
      new ArtifactRepository(join(dir, "artifacts.json")),
      new ArtifactBlobStore(join(dir, "artifact-blobs")),
      workspaces,
    );
    const source = new FileSandbox(join(workspaces, "source-session"));
    await source.initialize();
    await source.writeText("poster.svg", "<svg></svg>");
    const artifact = await artifacts.publishFile({
      ownerId: "local-admin", sessionId: "source-session", turnId: "source-turn", operationId: "source-op", path: "poster.svg",
    });
    const provider = new CapturingProvider();
    const sessions = new SessionRepository(join(dir, "sessions"));
    const runtimeSandbox = new FileSandbox(join(dir, "runtime"));
    await runtimeSandbox.initialize();
    const agent = new KindergartenAgent(
      sessions,
      AgentRuntime.fromRegistry(provider, new ToolRegistry(runtimeSandbox)),
      bindings(),
      undefined,
      undefined,
      artifacts,
    ).createApp();
    const updates: acp.SessionNotification[] = [];
    const client = acp.client({ name: "artifact-mention-client" })
      .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params); })
      .connect(agent);
    await client.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await client.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace", mcpServers: [],
      _meta: makeSessionBindingMeta({ schemaVersion: 1, modelStudentId: "fixture-student", agentId: "agent-a" }),
    });
    await client.agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "复用这张图" }],
      _meta: makePromptMeta({ schemaVersion: 1, turnId: "turn-a", artifactMentions: [{ artifactId: artifact.artifactId }] }),
    });

    const stored = await sessions.get(session.sessionId);
    expect(stored.sessionEntries[0]).toMatchObject({
      type: "message",
      artifactMentions: [{ artifactId: artifact.artifactId, uri: `artifact://${artifact.artifactId}`, displayName: "poster.svg" }],
    });
    expect(provider.inputs[0]?.messages.at(-1)?.content).toContain(`<artifact_mentions>`);
    expect(provider.inputs[0]?.messages.at(-1)?.content).toContain(artifact.artifactId);

    updates.length = 0;
    await client.agent.request(acp.methods.agent.session.load, { sessionId: session.sessionId, cwd: "/workspace", mcpServers: [] });
    const user = updates.find((item) => item.update.sessionUpdate === "user_message_chunk");
    expect(user && "_meta" in user.update ? readMessageMeta(user.update._meta)?.artifactMentions : undefined)
      .toMatchObject([{ artifactId: artifact.artifactId, displayName: "poster.svg" }]);
    client.close();
    await client.closed;
  });
});

class CapturingProvider extends FixtureProvider {
  readonly inputs: ModelInput[] = [];
  override async *stream(input: ModelInput, signal: AbortSignal) {
    this.inputs.push(structuredClone(input));
    yield* super.stream(input, signal);
  }
}

function bindings(): SessionBindingService {
  return new SessionBindingService({
    workspaceCwd: "/workspace",
    agentExists: () => true,
    modelStudentReady: () => true,
    experimentBinding: async () => undefined,
  });
}
