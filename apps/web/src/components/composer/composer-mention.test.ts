import { describe, expect, it } from "vitest";
import type { ArtifactRecord } from "@kindergarten/contracts";
import { addMention, mentionInputs, mentionQuery, removeMentionTrigger } from "./composer-mention.js";

describe("composer mention", () => {
  it("只识别当前词尾的 @ 搜索，不解析正文里的旧文本", () => {
    expect(mentionQuery("请使用 @海报")).toBe("海报");
    expect(mentionQuery("@" )).toBe("");
    expect(mentionQuery("请使用 @海报 继续")).toBeNull();
    expect(removeMentionTrigger("请使用 @海报")).toBe("请使用 ");
  });

  it("按 artifactId 去重并只发送稳定 ID", () => {
    const artifact = fixture("artifact_12345678", "同名文件");
    expect(addMention([artifact], { ...artifact, displayName: "改名" })).toEqual([artifact]);
    expect(mentionInputs([artifact])).toEqual([{ artifactId: "artifact_12345678" }]);
  });
});

function fixture(artifactId: string, displayName: string): ArtifactRecord {
  return {
    schemaVersion: 1, artifactId, ownerId: "local-admin", sourceSessionId: "session-a", sourceTurnId: "turn-a",
    kind: "file", displayName, state: "active", operationId: "op-a",
    primary: { sha256: "a".repeat(64), byteLength: 4, mimeType: "image/png" },
    createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z",
  };
}
