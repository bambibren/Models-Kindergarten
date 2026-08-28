const DEFAULT_SESSION_TITLE = "未命名会话";

/** 描述「ArtifactListLabel」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ArtifactListLabel {
  title: string;
  fullTitle: string;
  sessionRef: string;
}

/** 列表主标题同时保留任务来源和文件名；完整会话名只放在 tooltip，避免撑高每一行。 */
export function artifactListLabel(
  displayName: string,
  sourceSessionId: string,
  sessionTitle?: string,
  version = 1,
): ArtifactListLabel {
  const fullSessionTitle = normalizedSessionTitle(sessionTitle);
  return {
    title: `${shortText(fullSessionTitle, 16)} · ${displayName} · v${version}`,
    fullTitle: `${fullSessionTitle} · ${displayName} · v${version}`,
    sessionRef: `会话 #${sourceSessionId.slice(-6) || "未知"}`,
  };
}

/** 校验并规范化「normalizedSessionTitle」输入，非法数据直接返回明确错误。 */
function normalizedSessionTitle(value?: string): string {
  return value?.replace(/\s+/g, " ").trim() || DEFAULT_SESSION_TITLE;
}

/** 执行「shortText」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function shortText(value: string, limit: number): string {
  const characters = Array.from(value);
  return characters.length > limit ? `${characters.slice(0, limit).join("")}…` : value;
}
