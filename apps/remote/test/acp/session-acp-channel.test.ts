import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { SessionAcpChannel } from "../../src/acp/session-acp-channel.js";

describe("SessionAcpChannel", () => {
  it("旧连接上的反向请求悬挂时，resume 后改向新连接重新发起", async () => {
    const first = {} as acp.AgentContext;
    const second = {} as acp.AgentContext;
    const channel = new SessionAcpChannel(first, "session-resume");
    const operation = vi.fn((client: acp.AgentContext) =>
      client === first ? new Promise<string>(() => undefined) : Promise.resolve("new-client-result"));

    const result = channel.request("permission:call-1", new AbortController().signal, operation);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));

    channel.beginResume();
    await channel.finishResume(second);

    await expect(result).resolves.toBe("new-client-result");
    expect(operation.mock.calls.map(([client]) => client)).toEqual([first, second]);
    channel.close();
  });
});
