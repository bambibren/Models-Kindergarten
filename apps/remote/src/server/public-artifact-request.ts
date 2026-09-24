/** 公开 Artifact 是仅凭 opaque ID 读取 active 内容的能力 URL；写请求永不绕过登录。 */
export function isPublicArtifactReadRequest(request: Pick<Request, "method" | "url">): boolean {
  if (request.method !== "GET") return false;
  const path = new URL(request.url).pathname;
  return /^\/api\/control\/v1\/public\/artifacts\/[^/]+\/(?:preview|raw|content|pptx-playback)$/u.test(path) ||
    /^\/api\/control\/v1\/public\/artifacts\/[^/]+\/bundle\/.+$/u.test(path);
}
