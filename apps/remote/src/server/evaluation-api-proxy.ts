const PUBLIC_PREFIX = "/api/evaluation/v1";

type FetchPort = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** 只把固定的浏览器只读评测路径转发到受信任的 Evaluation Service。 */
export class EvaluationApiProxy {
  private readonly targetOrigin: string;

  constructor(targetOrigin: string, private readonly request: FetchPort = fetch) {
    this.targetOrigin = new URL(targetOrigin).origin;
  }

  async fetch(incoming: Request): Promise<Response | undefined> {
    const url = new URL(incoming.url);
    if (url.pathname !== PUBLIC_PREFIX && !url.pathname.startsWith(`${PUBLIC_PREFIX}/`)) return undefined;
    if (incoming.method !== "GET" && incoming.method !== "HEAD") {
      return Response.json({ error: "Evaluation 浏览器入口只允许读取" }, { status: 405 });
    }
    const suffix = url.pathname.slice(PUBLIC_PREFIX.length);
    const target = new URL(`/api/v1${suffix}${url.search}`, this.targetOrigin);
    try {
      const response = await this.request(target, {
        method: incoming.method,
        headers: { accept: incoming.headers.get("accept") ?? "application/json" },
        signal: incoming.signal,
      });
      const headers = new Headers();
      for (const name of ["content-type", "cache-control"]) {
        const value = response.headers.get(name);
        if (value) headers.set(name, value);
      }
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return Response.json({ error: "Evaluation Service 暂不可用" }, { status: 502 });
    }
  }
}
