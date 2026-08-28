import { describe, expect, it } from "vitest";
import type { ArtifactRecord } from "@kindergarten/contracts";
import { addMention, mentionInputs, mentionQuery, removeMentionTrigger } from "./composer-mention.js";

describe("composer mention", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("只识别当前词尾的 @ 搜索，不解析正文里的旧文本", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(mentionQuery("请使用 @海报")).toBe("海报");
    expect(mentionQuery("@" )).toBe("");
    expect(mentionQuery("请使用 @海报 继续")).toBeNull();
    expect(removeMentionTrigger("请使用 @海报")).toBe("请使用 ");
  });

  it("按 artifactId 去重并只发送稳定 ID", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const artifact = fixture("artifact_12345678", "同名文件");
    expect(addMention([artifact], { ...artifact, displayName: "改名" })).toEqual([artifact]);
    expect(mentionInputs([artifact])).toEqual([{ artifactId: "artifact_12345678" }]);
  });
});

/** 构造「fixture」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function fixture(artifactId: string, displayName: string): ArtifactRecord {
  return {
    schemaVersion: 1, artifactId, ownerId: "local-admin", sourceSessionId: "session-a", sourceTurnId: "turn-a",
    kind: "file", displayName, state: "active", operationId: "op-a",
    primary: { sha256: "a".repeat(64), byteLength: 4, mimeType: "image/png" },
    createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z",
  };
}
