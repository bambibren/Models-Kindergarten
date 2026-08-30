import { describe, expect, it } from "vitest";
import {
  isPublicIp,
  RemoteModelUrlPolicy,
  RemoteModelUrlPolicyError,
} from "../../src/model/remote-model-url-policy.js";

describe("RemoteModelUrlPolicy", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("只接受全部解析到公网地址的 HTTPS 端点", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const policy = new RemoteModelUrlPolicy(/** 构造「policy」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => [
      { address: "8.8.8.8" },
      { address: "2606:4700:4700::1111" },
    ]);
    await expect(policy.assert("https://models.example.test/v1")).resolves.toBeUndefined();
    await expect(policy.resolve("https://models.example.test/v1")).resolves.toEqual({
      url: new URL("https://models.example.test/v1"),
      addresses: [
        { address: "8.8.8.8", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ],
    });
  });

  it.each([
    "http://models.example.test/v1",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.1/v1",
    "https://[::1]/v1",
    "https://[::ffff:127.0.0.1]/v1",
  ])("拒绝非 HTTPS、本机、私网和元数据地址: %s", /** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
async (url) => {
    await expect(new RemoteModelUrlPolicy().assert(url)).rejects.toMatchObject({ reason: "not_allowed" });
  });

  it("任一 DNS 结果为私网地址时拒绝整个主机", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const policy = new RemoteModelUrlPolicy(/** 构造「policy」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => [
      { address: "8.8.8.8" },
      { address: "192.168.1.10" },
    ]);
    await expect(policy.assert("https://models.example.test/v1")).rejects.toBeInstanceOf(RemoteModelUrlPolicyError);
  });

  it("DNS 故障与安全拒绝使用不同原因", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const policy = new RemoteModelUrlPolicy(/** 构造「policy」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => { throw new Error("NXDOMAIN"); });
    await expect(policy.assert("https://missing.example.test/v1")).rejects.toMatchObject({ reason: "dns_failed" });
  });

  it("识别常见公网与非公网 IP", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
    expect(isPublicIp("100.64.0.1")).toBe(false);
    expect(isPublicIp("198.51.100.4")).toBe(false);
    expect(isPublicIp("2001:db8::1")).toBe(false);
  });
});
