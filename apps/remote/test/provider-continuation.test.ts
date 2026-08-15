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

describe("ProviderOpaqueContinuation v2", () => {
  it("保存协议无关 JSON payload、精确字节数和去重关联元数据", () => {
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

  it("关联信息可在投影边界补齐，但 payload 与字节数保持不变", () => {
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

  it("消费绑定同时校验 ModelStudent、provider kind、protocol 与 model", () => {
    const continuation = createProviderOpaqueContinuation({
      modelStudentId: student.id,
      providerKind: student.provider.kind,
      protocol: "openai_responses",
      model: student.provider.model,
      format: "openai-responses-output-v1",
      payload: { items: [] },
    });
    expect(() => assertContinuationTargetsStudent(
      continuation,
      student,
      "openai_responses",
    )).not.toThrow();
    expect(() => assertContinuationTargetsStudent(
      continuation,
      { ...student, id: "student-b", provider: { ...student.provider, baseUrl: "https://endpoint-b.example/v1" } },
      "openai_responses",
    )).toThrow("不匹配");
    expect(() => assertContinuationTargetsStudent(
      continuation,
      student,
      "openai_chat_completions",
    )).toThrow("不匹配");
  });

  it("普通运行时读取拒绝无身份绑定的旧 v1，且拒绝伪造 payload 字节数", () => {
    expect(() => readProviderOpaqueContinuation({
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
    expect(() => readProviderOpaqueContinuation({
      ...valid,
      payloadByteLength: valid.payloadByteLength + 1,
    })).toThrow("payloadByteLength");
  });
});
