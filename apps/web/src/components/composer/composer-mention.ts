import type { ArtifactMentionInput, ArtifactRecord } from "@kindergarten/contracts";

export function mentionQuery(text: string): string | null {
  const match = text.match(/(?:^|\s)@([^\s@]*)$/u);
  return match ? (match[1] ?? "") : null;
}

export function removeMentionTrigger(text: string): string {
  return text.replace(/(^|\s)@[^\s@]*$/u, "$1");
}

export function addMention(current: ArtifactRecord[], artifact: ArtifactRecord): ArtifactRecord[] {
  return current.some((item) => item.artifactId === artifact.artifactId) ? current : [...current, artifact];
}

export function mentionInputs(artifacts: ArtifactRecord[]): ArtifactMentionInput[] {
  return artifacts.map((item) => ({ artifactId: item.artifactId }));
}
