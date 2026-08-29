const developmentOrigin = "http://127.0.0.1:5173";

/** 使用页面当前源站生成可公开复制的 Skill 地址，避免把开发端口或生产域名写进提示词。 */
export function publicSkillUrl(name: string, origin = currentOrigin()): string {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Skill 名称无效: ${name}`);
  return new URL(`/skills/${name}`, normalizeOrigin(origin)).href;
}

/** 浏览器运行时读取页面源站；Node 测试使用稳定的源码开发入口。 */
export function currentOrigin(): string {
  const origin = globalThis.location?.origin;
  return origin && origin !== "null" ? origin : developmentOrigin;
}

function normalizeOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error(`公开源站必须是无路径、无凭据的 origin: ${origin}`);
  }
  return url.origin;
}
