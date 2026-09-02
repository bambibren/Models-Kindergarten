import { describe, expect, it } from "vitest";
import {
  makeAcpMeta,
  makePromptMeta,
  readContextSummaryNotification,
  readContextWindowUsageNotification,
  readMessageMeta,
  readPromptMeta,
  readTokenUsageNotification,
} from "./index.js";

describe("Model attempt message meta", () => {
  it("保留 Attempt 代次和整体重置标记", () => {
    expect(readMessageMeta(makeAcpMeta({
      schemaVersion: 1,
      turnId: "turn-1",
      chunkIndex: 0,
      modelAttempt: { id: "attempt-1", index: 1, reset: true },
    }))).toMatchObject({
      modelAttempt: { id: "attempt-1", index: 1, reset: true },
    });
  });
});

describe("Context window usage notification", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("保留下一次请求基础上下文估算和冻结窗口", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(readContextWindowUsageNotification({
      sessionId: "session-1",
      state: {
        schemaVersion: 1,
        status: "available",
        afterTurnId: "turn-2",
        estimatedTokens: 38_400,
        windowTokens: 128_000,
        basis: "next_prompt_base",
      },
    })).toEqual({
      sessionId: "session-1",
      state: {
        schemaVersion: 1,
        status: "available",
        afterTurnId: "turn-2",
        estimatedTokens: 38_400,
        windowTokens: 128_000,
        basis: "next_prompt_base",
      },
    });
  });

  it("接受显式不可用状态，拒绝非法容量和口径", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(readContextWindowUsageNotification({
      sessionId: "session-1",
      state: {
        schemaVersion: 1,
        status: "unavailable",
        afterTurnId: "turn-2",
        reason: "preview_failed",
      },
    }).state).toMatchObject({ status: "unavailable", reason: "preview_failed" });

    for (const state of [
      { schemaVersion: 1, status: "available", afterTurnId: "turn-2", estimatedTokens: -1, windowTokens: 128_000, basis: "next_prompt_base" },
      { schemaVersion: 1, status: "available", afterTurnId: "turn-2", estimatedTokens: 10, windowTokens: 0, basis: "next_prompt_base" },
      { schemaVersion: 1, status: "available", afterTurnId: "turn-2", estimatedTokens: 10, windowTokens: 128_000, basis: "last_request" },
      { schemaVersion: 1, status: "unavailable", afterTurnId: "turn-2", reason: "stale" },
    ]) {
      expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => readContextWindowUsageNotification({ sessionId: "session-1", state })).toThrow("上下文窗口");
    }
  });
});

describe("Artifact prompt meta", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("保留手动重试 operationId，并且 Mention 只接收稳定 Artifact ID", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const value = readPromptMeta(makePromptMeta({
      schemaVersion: 1,
      turnId: "turn-retry",
      operationId: "operation-stable",
      artifactMentions: [{ artifactId: "artifact_12345678" }],
    }));

    expect(value).toEqual({
      schemaVersion: 1,
      turnId: "turn-retry",
      operationId: "operation-stable",
      artifactMentions: [{ artifactId: "artifact_12345678" }],
    });
  });
});

describe("Context summary notification", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("保留当前模型适配层的原文快照", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const result = readContextSummaryNotification({
      sessionId: "session-1",
      summary: {
        schemaVersion: 1,
        turnId: "turn-1",
        totalEstimatedTokens: 8,
        items: [{
          id: "system-prompt",
          kind: "system_instruction",
          title: "Agent 基础指令",
          estimatedTokens: 8,
          raw: {
            provider: "ollama",
            model: "qwen3:8b",
            format: "json",
            value: "{\n  \"role\": \"system\"\n}",
          },
        }],
      },
    });

    expect(result.summary.items[0]?.raw).toEqual({
      provider: "ollama",
      model: "qwen3:8b",
      format: "json",
      value: "{\n  \"role\": \"system\"\n}",
    });
  });

  it("兼容旧 Session 缺少 raw，但拒绝伪造的适配层格式", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const base = {
      sessionId: "session-1",
      summary: {
        schemaVersion: 1,
        turnId: "turn-1",
        totalEstimatedTokens: 8,
        items: [{
          id: "system-prompt",
          kind: "system_instruction",
          title: "Agent 基础指令",
          estimatedTokens: 8,
        }],
      },
    };
    expect(readContextSummaryNotification(base).summary.items[0]?.raw).toBeUndefined();

    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => readContextSummaryNotification({
      ...base,
      summary: {
        ...base.summary,
        items: [{
          ...base.summary.items[0],
          raw: { provider: "ollama", model: "qwen3:8b", format: "yaml", value: "role: system" },
        }],
      },
    })).toThrow("上下文提要原文格式无效");
  });
});

describe("Token usage notification", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("保留精确总量和估算分项，并允许 Provider 缺少子集字段", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const result = readTokenUsageNotification({
      sessionId: "session-1",
      usage: {
        schemaVersion: 1,
        turnId: "turn-1",
        modelRequests: 2,
        inputTokens: 120,
        outputTokens: 35,
        components: [{
          category: "current_prompt",
          targetType: "message",
          targetId: "message-1",
          estimatedTokens: 8,
        }],
      },
    });
    expect(result).toMatchObject({
      usage: {
        inputTokens: 120,
        outputTokens: 35,
      },
    });
    expect(result.usage.cachedInputTokens).toBeUndefined();
  });

  it("拒绝负数 token 和不匹配的目标类型", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => readTokenUsageNotification({
      sessionId: "session-1",
      usage: {
        schemaVersion: 1,
        turnId: "turn-1",
        modelRequests: 1,
        inputTokens: -1,
        components: [],
      },
    })).toThrow("Token 用量字段无效");

    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => readTokenUsageNotification({
      sessionId: "session-1",
      usage: {
        schemaVersion: 1,
        turnId: "turn-1",
        modelRequests: 1,
        components: [{
          category: "reasoning",
          targetType: "message",
          targetId: "message-1",
          estimatedTokens: 3,
        }],
      },
    })).toThrow("Token 用量分项格式无效");
  });
});
