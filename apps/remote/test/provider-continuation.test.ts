import { describe, expect, it } from "vitest";
import type { ModelStudent } from "../src/model/model-provider.js";
import {
  assertContinuationTargetsStudent,
  createProviderOpaqueContinuation,
  readProviderOpaqueContinuation,
  withProviderContinuationCorrelation,
} from "../src/model/provider-continuation.js";

const student: ModelStudent = {
  id: "student-a",
  name: "Student A",
  sizeClass: "large",
  provider: {
    kind: "openai-compatible",
    model: "same-model",
    baseUrl: "https://endpoint-a.example/v1",
  },
  generationDefaults: {},
};

describe("ProviderOpaqueContinuation v2", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("保存协议无关 JSON payload、精确字节数和去重关联元数据", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const continuation = createProviderOpaqueContinuation({
      modelStudentId: student.id,
      providerKind: student.provider.kind,
      protocol: "future_messages_protocol",
      model: student.provider.model,
      format: "future-payload-v1",
      payload: { content: ["中文", { call: "call-1" }] },
      correlation: { messageIds: ["m1", "m1"], toolCallIds: ["call-1"] },
    });

    expect(continuation).toMatchObject({
      schemaVersion: 2,
      protocol: "future_messages_protocol",
      correlation: { messageIds: ["m1"], toolCallIds: ["call-1"] },
    });
    expect(continuation.payloadByteLength).toBe(
      Buffer.byteLength(JSON.stringify(continuation.payload), "utf8"),
    );
  });

  it("关联信息可在投影边界补齐，但 payload 与字节数保持不变", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const original = createProviderOpaqueContinuation({
      modelStudentId: student.id,
      providerKind: student.provider.kind,
      protocol: "openai_responses",
      model: student.provider.model,
      format: "openai-responses-output-v1",
      payload: { items: [{ type: "reasoning", encrypted_content: "opaque" }] },
    });
    const correlated = withProviderContinuationCorrelation(original, {
      messageIds: ["thought-1"],
      toolCallIds: ["call-1"],
    });

    expect(correlated.payload).toEqual(original.payload);
    expect(correlated.payloadByteLength).toBe(original.payloadByteLength);
    expect(correlated.correlation).toEqual({
      messageIds: ["thought-1"],
      toolCallIds: ["call-1"],
    });
  });

  it("消费绑定同时校验 ModelStudent、provider kind、protocol 与 model", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const continuation = createProviderOpaqueContinuation({
      modelStudentId: student.id,
      providerKind: student.provider.kind,
      protocol: "openai_responses",
      model: student.provider.model,
      format: "openai-responses-output-v1",
      payload: { items: [] },
    });
    expect(/** 构造「not」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => assertContinuationTargetsStudent(
      continuation,
      student,
      "openai_responses",
    )).not.toThrow();
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => assertContinuationTargetsStudent(
      continuation,
      { ...student, id: "student-b", provider: { ...student.provider, baseUrl: "https://endpoint-b.example/v1" } },
      "openai_responses",
    )).toThrow("不匹配");
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => assertContinuationTargetsStudent(
      continuation,
      student,
      "openai_chat_completions",
    )).toThrow("不匹配");
  });

  it("普通运行时读取拒绝无身份绑定的旧 v1，且拒绝伪造 payload 字节数", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => readProviderOpaqueContinuation({
      schemaVersion: 1,
      providerKind: "openai-compatible",
      model: "same-model",
      format: "openai-responses-output-v1",
      items: [],
    })).toThrow("schemaVersion");

    const valid = createProviderOpaqueContinuation({
      modelStudentId: student.id,
      providerKind: student.provider.kind,
      protocol: "openai_responses",
      model: student.provider.model,
      format: "openai-responses-output-v1",
      payload: { items: [] },
    });
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => readProviderOpaqueContinuation({
      ...valid,
      payloadByteLength: valid.payloadByteLength + 1,
    })).toThrow("payloadByteLength");
  });
});
