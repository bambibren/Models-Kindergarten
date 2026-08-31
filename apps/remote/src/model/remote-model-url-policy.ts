import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import type { ResolvedHttpEndpoint } from "./pinned-http-transport.js";

/** 描述「RemoteModelLookup」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type RemoteModelLookup = (hostname: string) => Promise<Array<{ address: string; family?: number }>>;

/** 受管模型端点的地址策略；默认严格，只有部署组装层可显式放宽本地网络。 */
export interface RemoteModelUrlPolicyOptions {
  lookup?: RemoteModelLookup;
  allowPrivateNetwork?: boolean;
}

/** 描述「RemoteModelUrlPolicyError」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class RemoteModelUrlPolicyError extends Error {
  /** 初始化「RemoteModelUrlPolicyError」所需依赖，不在构造阶段启动不可回收的后台任务。 */
  constructor(
    readonly reason: "not_allowed" | "dns_failed",
    message: string,
  ) {
    super(message);
  }
}

/**
 * 自定义模型端点始终要求 HTTPS；线上型部署还要求全部 A/AAAA 结果均为公网地址。
 * 源码本地开发可接受 VPN Fake-IP、loopback 和局域网，但仍返回固定 DNS 地址票据。
 */
export class RemoteModelUrlPolicy {
  private readonly lookup: RemoteModelLookup;
  private readonly allowPrivateNetwork: boolean;

  /** 初始化「RemoteModelUrlPolicy」所需依赖，不在构造阶段启动不可回收的后台任务。 */
  constructor(options: RemoteModelUrlPolicyOptions = {}) {
    this.lookup = options.lookup ?? (/** 执行「lookup」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
    this.allowPrivateNetwork = options.allowPrivateNetwork === true;
  }

  /** 校验并规范化「assert」输入，非法数据直接返回明确错误。 */
  async assert(input: URL | string): Promise<void> {
    await this.resolve(input);
  }

  /** 单次解析、校验并返回可直接绑定到 socket lookup 的不可变地址票据。 */
  async resolve(input: URL | string): Promise<ResolvedHttpEndpoint> {
    let url: URL;
    try {
      url = input instanceof URL ? new URL(input) : new URL(input);
    } catch {
      throw new RemoteModelUrlPolicyError("not_allowed", "模型 Base URL 无效");
    }
    if (url.protocol !== "https:") {
      throw new RemoteModelUrlPolicyError("not_allowed", "模型 Base URL 必须使用 HTTPS");
    }
    if (url.username || url.password) {
      throw new RemoteModelUrlPolicyError("not_allowed", "模型 Base URL 不能包含用户名或密码");
    }

    const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
    if (!hostname || (!this.allowPrivateNetwork &&
      (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")))) {
      throw new RemoteModelUrlPolicyError("not_allowed", "模型 Base URL 必须指向公网主机");
    }

    const literalKind = isIP(hostname);
    if (literalKind !== 0) {
      if (!this.allowPrivateNetwork && !isPublicIp(hostname)) {
        throw new RemoteModelUrlPolicyError("not_allowed", "模型 Base URL 不能指向私网或保留地址");
      }
      return {
        url,
        addresses: [{ address: hostname, family: literalKind as 4 | 6 }],
      };
    }

    let addresses: Array<{ address: string; family?: number }>;
    try {
      addresses = await this.lookup(hostname);
    } catch {
      throw new RemoteModelUrlPolicyError("dns_failed", "模型 Base URL 无法完成 DNS 解析");
    }
    if (addresses.length === 0) {
      throw new RemoteModelUrlPolicyError("dns_failed", "模型 Base URL 没有可用的 DNS 地址");
    }
    if (!this.allowPrivateNetwork && addresses.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
({ address }) => !isPublicIp(address))) {
      throw new RemoteModelUrlPolicyError("not_allowed", "模型 Base URL 的 DNS 结果包含私网或保留地址");
    }
    const resolved = addresses.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
({ address, family }) => {
      const actualFamily = isIP(address);
      if ((actualFamily !== 4 && actualFamily !== 6) || family !== undefined && family !== actualFamily) {
        throw new RemoteModelUrlPolicyError("dns_failed", "模型 Base URL 的 DNS 结果格式无效");
      }
      return { address: stripIpv6Brackets(address).toLowerCase(), family: actualFamily as 4 | 6 };
    });
    const unique = [...new Map(resolved.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => [`${item.family}:${item.address}`, item])).values()];
    return { url, addresses: unique };
  }
}

/** 判断「isPublicIp」对应条件，只返回判定结果且不修改输入状态。 */
export function isPublicIp(value: string): boolean {
  const normalized = stripIpv6Brackets(value).toLowerCase();
  const kind = isIP(normalized);
  if (kind === 4) return isPublicIpv4(normalized);
  if (kind !== 6) return false;

  const mapped = mappedIpv4(normalized);
  if (mapped) return isPublicIpv4(mapped);
  const groups = expandIpv6(normalized);
  if (!groups) return false;
  const [first = 0, second = 0] = groups;

  if (groups.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(group) => group === 0) || groups.slice(0, 7).every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(group) => group === 0) && groups[7] === 1) return false;
  if ((first & 0xfe00) === 0xfc00) return false; // 拒绝 fc00::/7 唯一本地地址。
  if ((first & 0xffc0) === 0xfe80) return false; // 拒绝 fe80::/10 链路本地地址。
  if ((first & 0xff00) === 0xff00) return false; // 拒绝组播地址。
  if (first === 0x0100 && groups.slice(1, 4).every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(group) => group === 0)) return false; // 拒绝 100::/64 discard-only 地址。
  if (first === 0x2001 && second === 0x0db8) return false; // 拒绝文档示例地址段。
  if (first === 0x2001 && (second === 0 || second === 2 || (second & 0xfff0) === 0x0010)) return false;
  if (first === 0x2002) return false; // 6to4 可能封装私有 IPv4，必须拒绝。
  if (first === 0x0064 && second === 0xff9b && groups[2] === 1) return false; // 拒绝本地用途 NAT64。
  return true;
}

/** 判断「isPublicIpv4」对应条件，只返回判定结果且不修改输入状态。 */
function isPublicIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

/** 执行「mappedIpv4」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function mappedIpv4(value: string): string | undefined {
  const dotted = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value)?.[1];
  if (dotted && (value.startsWith("::ffff:") || value.startsWith("::"))) return dotted;
  const groups = expandIpv6(value);
  if (!groups || !groups.slice(0, 5).every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(group) => group === 0) || groups[5] !== 0xffff) return undefined;
  const high = groups[6];
  const low = groups[7];
  if (high === undefined || low === undefined) return undefined;
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** 执行「expandIpv6」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function expandIpv6(value: string): number[] | undefined {
  let input = value;
  const dotted = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(input)?.[1];
  if (dotted) {
    const octets = dotted.split(".").map(Number);
    if (octets.length !== 4 || octets.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item < 0 || item > 255)) return undefined;
    input = input.slice(0, -dotted.length) + `${((octets[0] ?? 0) << 8 | (octets[1] ?? 0)).toString(16)}:${((octets[2] ?? 0) << 8 | (octets[3] ?? 0)).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const textGroups = [...left, ...Array.from({ length: Math.max(0, missing) }, /** 执行「textGroups」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => "0"), ...right];
  if (textGroups.length !== 8) return undefined;
  const groups = textGroups.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(group) => Number.parseInt(group, 16));
  return groups.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(group, index) => !/^[0-9a-f]{1,4}$/i.test(textGroups[index] ?? "") || !Number.isFinite(group))
    ? undefined
    : groups;
}

/** 执行「stripIpv6Brackets」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}
