import type { LocalPrincipal } from "@kindergarten/contracts";

/** 描述「ControlRouteContext」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ControlRouteContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
  requestId: string;
  principal: LocalPrincipal;
  json(): Promise<unknown>;
}

/** 描述「ControlRouteHandler」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ControlRouteHandler = (context: ControlRouteContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: ControlRouteHandler;
}

/** 描述「ControlRouter」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class ControlRouter {
  private readonly routes: Route[] = [];

  /** 执行「register」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
register(method: string, pattern: string, handler: ControlRouteHandler): void {
    this.routes.push({ method: method.toUpperCase(), pattern, segments: split(pattern), handler });
  }

  /** 执行「match」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
match(method: string, path: string): { handler: ControlRouteHandler; params: Record<string, string> } | undefined {
    const pathSegments = split(path);
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      const params = matchSegments(route.segments, pathSegments);
      if (params) return { handler: route.handler, params };
    }
    return undefined;
  }

  /** 执行「allowedMethods」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
allowedMethods(path: string): string[] {
    const pathSegments = split(path);
    return this.routes
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(route) => matchSegments(route.segments, pathSegments) !== undefined)
      .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(route) => route.method)
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(method, index, all) => all.indexOf(method) === index)
      .toSorted();
  }
}

/** 执行「split」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function split(path: string): string[] {
  return path.split("/").filter(Boolean).map(decodeURIComponent);
}

/** 执行「matchSegments」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function matchSegments(pattern: string[], path: string[]): Record<string, string> | undefined {
  const wildcardIndex = pattern.findIndex(/** 执行「wildcardIndex」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item.startsWith("*"));
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
