import type { LocalPrincipal } from "@kindergarten/contracts";

export interface ControlRouteContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
  requestId: string;
  principal: LocalPrincipal;
  json(): Promise<unknown>;
}

export type ControlRouteHandler = (context: ControlRouteContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: ControlRouteHandler;
}

export class ControlRouter {
  private readonly routes: Route[] = [];

  register(method: string, pattern: string, handler: ControlRouteHandler): void {
    this.routes.push({ method: method.toUpperCase(), pattern, segments: split(pattern), handler });
  }

  match(method: string, path: string): { handler: ControlRouteHandler; params: Record<string, string> } | undefined {
    const pathSegments = split(path);
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      const params = matchSegments(route.segments, pathSegments);
      if (params) return { handler: route.handler, params };
    }
    return undefined;
  }

  allowedMethods(path: string): string[] {
    const pathSegments = split(path);
    return this.routes
      .filter((route) => matchSegments(route.segments, pathSegments) !== undefined)
      .map((route) => route.method)
      .filter((method, index, all) => all.indexOf(method) === index)
      .toSorted();
  }
}

function split(path: string): string[] {
  return path.split("/").filter(Boolean).map(decodeURIComponent);
}

function matchSegments(pattern: string[], path: string[]): Record<string, string> | undefined {
  const wildcardIndex = pattern.findIndex((item) => item.startsWith("*"));
  if (wildcardIndex >= 0 && wildcardIndex !== pattern.length - 1) return undefined;
  if (wildcardIndex < 0 && pattern.length !== path.length) return undefined;
  if (wildcardIndex >= 0 && path.length < wildcardIndex) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index] ?? "";
    if (expected.startsWith("*")) {
      params[expected.slice(1)] = path.slice(index).join("/");
      return params;
    }
    const actual = path[index] ?? "";
    if (expected.startsWith(":")) params[expected.slice(1)] = actual;
    else if (expected !== actual) return undefined;
  }
  return params;
}
