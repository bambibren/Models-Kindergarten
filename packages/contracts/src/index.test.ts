import { describe, expect, it } from "vitest";
import {
  makePromptMeta,
  readContextSummaryNotification,
  readPromptMeta,
  readTokenUsageNotification,
} from "./index.js";

describe("Artifact prompt meta", () => {
  it("保留手动重试 operationId，并且 Mention 只接收稳定 Artifact ID", () => {
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

describe("Context summary notification", () => {
  it("保留当前模型适配层的原文快照", () => {
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

  it("兼容旧 Session 缺少 raw，但拒绝伪造的适配层格式", () => {
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

    expect(() => readContextSummaryNotification({
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

describe("Token usage notification", () => {
  it("保留精确总量和估算分项，并允许 Provider 缺少子集字段", () => {
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

  it("拒绝负数 token 和不匹配的目标类型", () => {
    expect(() => readTokenUsageNotification({
      sessionId: "session-1",
      usage: {
        schemaVersion: 1,
        turnId: "turn-1",
        modelRequests: 1,
        inputTokens: -1,
        components: [],
      },
    })).toThrow("Token 用量字段无效");

    expect(() => readTokenUsageNotification({
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
