import type { ArtifactMentionInput } from "@kindergarten/contracts";

const STORAGE_PREFIX = "mk.context-lab.entry.";

export interface ContextLabEntryDraft {
  schemaVersion: 1;
  promptText: string;
  artifactMentions: ArtifactMentionInput[];
}

interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 首页跳转只在 URL 中携带一次性标识，Prompt 与 Artifact ID 留在当前浏览器会话。 */
export function saveContextLabEntryDraft(
  storage: DraftStorage,
  promptText: string,
  artifactMentions: ArtifactMentionInput[],
  entryId: string = globalThis.crypto.randomUUID(),
): string {
  const draft: ContextLabEntryDraft = {
    schemaVersion: 1,
    promptText,
    artifactMentions: artifactMentions.map((item) => ({ artifactId: item.artifactId })),
  };
  storage.setItem(`${STORAGE_PREFIX}${entryId}`, JSON.stringify(draft));
  return `/context-lab?entry=${encodeURIComponent(entryId)}`;
}

/** 读取首页交接草稿；非法或过期内容按无交接处理，不从 URL 猜测 Prompt。 */
export function readContextLabEntryDraft(storage: DraftStorage, search: string): ContextLabEntryDraft | undefined {
  const entryId = new URLSearchParams(search).get("entry");
  if (!entryId) return undefined;
  const raw = storage.getItem(`${STORAGE_PREFIX}${entryId}`);
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.schemaVersion !== 1 || typeof value.promptText !== "string" || !Array.isArray(value.artifactMentions)) return undefined;
    const artifactMentions = value.artifactMentions.map((item) => {
      if (!record(item) || typeof item.artifactId !== "string" || item.artifactId.length === 0) throw new Error("artifactId 无效");
      return { artifactId: item.artifactId };
    });
    return { schemaVersion: 1, promptText: value.promptText, artifactMentions };
  } catch {
    return undefined;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
