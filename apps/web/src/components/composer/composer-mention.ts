import type { ArtifactMentionInput, ArtifactRecord } from "@kindergarten/contracts";

/** 执行「mentionQuery」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function mentionQuery(text: string): string | null {
  const match = text.match(/(?:^|\s)@([^\s@]*)$/u);
  return match ? (match[1] ?? "") : null;
}

/** 释放或删除「removeMentionTrigger」对应资源，重复调用仍保持安全。 */
export function removeMentionTrigger(text: string): string {
  return text.replace(/(^|\s)@[^\s@]*$/u, "$1");
}

/** 执行「addMention」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function addMention(current: ArtifactRecord[], artifact: ArtifactRecord): ArtifactRecord[] {
  return current.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.artifactId === artifact.artifactId) ? current : [...current, artifact];
}

/** 执行「mentionInputs」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function mentionInputs(artifacts: ArtifactRecord[]): ArtifactMentionInput[] {
  return artifacts.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({ artifactId: item.artifactId }));
}
