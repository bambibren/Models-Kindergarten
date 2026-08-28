import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { SessionAcpChannel } from "../../src/acp/session-acp-channel.js";

describe("SessionAcpChannel", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("旧连接上的反向请求悬挂时，resume 后改向新连接重新发起", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const first = {} as acp.AgentContext;
    const second = {} as acp.AgentContext;
    const channel = new SessionAcpChannel(first, "session-resume");
    const operation = vi.fn(/** 构造「operation」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(client: acp.AgentContext) =>
      client === first ? new Promise<string>(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
() => undefined) : Promise.resolve("new-client-result"));

    const result = channel.request("permission:call-1", new AbortController().signal, operation);
    await vi.waitFor(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
() => expect(operation).toHaveBeenCalledTimes(1));

    channel.beginResume();
    await channel.finishResume(second);

    await expect(result).resolves.toBe("new-client-result");
    expect(operation.mock.calls.map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
([client]) => client)).toEqual([first, second]);
    channel.close();
  });
});
