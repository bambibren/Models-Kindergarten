import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentCapabilitySet } from "../capability/capability-types.js";
import type {
  McpAuthProfile,
  McpConfigDocument,
  McpServerConfig,
  McpTransportConfig,
  SecretRef,
} from "./mcp-types.js";

const EMPTY_CONFIG: McpConfigDocument = {
  version: 1,
  servers: [],
  authProfiles: [],
  agentCapabilities: { mcpTools: [], skills: ["sandbox-notes"], resources: [] },
};

/** 配置只保存公开元数据与 Secret 引用；连接状态从不回写这里。 */
export class McpConfigStore {
  constructor(readonly file: string) {}

  async load(): Promise<McpConfigDocument> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file, "utf8")) as unknown;
    } catch (error) {
      if (isMissing(error)) return structuredClone(EMPTY_CONFIG);
      throw new Error(`读取 MCP 配置失败: ${errorText(error)}`, { cause: error });
    }
    return parseDocument(raw);
  }

  async save(document: McpConfigDocument): Promise<void> {
    const checked = parseDocument(document);
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, `${JSON.stringify(checked, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.file);
  }
}

function parseDocument(value: unknown): McpConfigDocument {
  const record = requiredRecord(value, "MCP 配置");
  if (record.version !== 1) throw new Error("MCP 配置 version 必须为 1");
  const servers = requiredArray(record.servers, "servers").map(parseServer);
  const authProfiles = requiredArray(record.authProfiles, "authProfiles").map(parseAuth);
  const agentCapabilities = parseCapabilities(record.agentCapabilities);
  assertUnique(servers.map((item) => item.id), "MCP server id");
  assertUnique(authProfiles.map((item) => item.id), "MCP auth profile id");
  for (const server of servers) {
    const authId = server.transport.kind === "streamable_http"
      ? server.transport.authProfileId
      : undefined;
    if (authId && !authProfiles.some((item) => item.id === authId)) {
      throw new Error(`MCP Server ${server.id} 引用了不存在的鉴权配置 ${authId}`);
    }
  }
  const serverIds = new Set(servers.map((item) => item.id));
  assertUnique(agentCapabilities.mcpTools.map((item) => item.id), "Agent MCP Tool id");
  assertUnique(agentCapabilities.skills, "Agent Skill id");
  assertUnique(
    agentCapabilities.resources.map((item) => `${item.serverId}\u0000${item.uri}`),
    "Agent MCP Resource",
  );
  for (const tool of agentCapabilities.mcpTools) {
    const match = tool.id.match(/^mcp:([^:]+):tool:(.+)$/);
    if (!match || !serverIds.has(match[1]!)) {
      throw new Error(`Agent MCP Tool 引用了不存在的 Server: ${tool.id}`);
    }
  }
  for (const skill of agentCapabilities.skills) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill)) {
      throw new Error(`Agent Skill name 格式无效: ${skill}`);
    }
  }
  for (const resource of agentCapabilities.resources) {
    if (!serverIds.has(resource.serverId)) {
      throw new Error(`Agent MCP Resource 引用了不存在的 Server: ${resource.serverId}`);
    }
  }
  return { version: 1, servers, authProfiles, agentCapabilities };
}

function parseServer(value: unknown): McpServerConfig {
  const record = requiredRecord(value, "server");
  const source = oneOf(record.source, ["manual", "project", "registry"] as const, "server.source");
  const trust = oneOf(record.trust, ["approved", "untrusted"] as const, "server.trust");
  return {
    id: identifier(record.id, "server.id"),
    displayName: nonEmptyString(record.displayName, "server.displayName"),
    enabled: booleanValue(record.enabled, "server.enabled"),
    source,
    trust,
    transport: parseTransport(record.transport),
  };
}

function parseTransport(value: unknown): McpTransportConfig {
  const record = requiredRecord(value, "server.transport");
  if (record.kind === "stdio") {
    const sandbox = record.sandbox === undefined ? undefined : requiredRecord(record.sandbox, "stdio.sandbox");
    return {
      kind: "stdio",
      command: nonEmptyString(record.command, "stdio.command"),
      ...(record.args === undefined ? {} : { args: stringArray(record.args, "stdio.args") }),
      ...(record.cwd === undefined ? {} : { cwd: nonEmptyString(record.cwd, "stdio.cwd") }),
      ...(record.envRefs === undefined ? {} : { envRefs: secretMap(record.envRefs, "stdio.envRefs") }),
      ...(sandbox === undefined ? {} : {
        sandbox: {
          ...(sandbox.readPaths === undefined ? {} : { readPaths: stringArray(sandbox.readPaths, "sandbox.readPaths") }),
          ...(sandbox.writePaths === undefined ? {} : { writePaths: stringArray(sandbox.writePaths, "sandbox.writePaths") }),
          ...(sandbox.network === undefined ? {} : { network: booleanValue(sandbox.network, "sandbox.network") }),
        },
      }),
    };
  }
  if (record.kind === "streamable_http") {
    return {
      kind: "streamable_http",
      url: nonEmptyString(record.url, "http.url"),
      ...(record.authProfileId === undefined
        ? {}
        : { authProfileId: identifier(record.authProfileId, "http.authProfileId") }),
      ...(record.headerRefs === undefined ? {} : { headerRefs: secretMap(record.headerRefs, "http.headerRefs") }),
      ...(record.allowPrivateNetwork === undefined
        ? {}
        : { allowPrivateNetwork: booleanValue(record.allowPrivateNetwork, "http.allowPrivateNetwork") }),
    };
  }
  throw new Error("server.transport.kind 必须是 stdio 或 streamable_http");
}

function parseAuth(value: unknown): McpAuthProfile {
  const record = requiredRecord(value, "authProfile");
  const kind = oneOf(record.kind, ["none", "bearer", "oauth"] as const, "authProfile.kind");
  if (kind === "none" && record.tokenRef !== undefined) {
    throw new Error("none 鉴权配置不能包含 tokenRef");
  }
  if (kind !== "none" && record.tokenRef === undefined) {
    throw new Error(`${kind} 鉴权配置必须包含 tokenRef`);
  }
  return {
    id: identifier(record.id, "authProfile.id"),
    kind,
    ...(record.tokenRef === undefined ? {} : { tokenRef: parseSecretRef(record.tokenRef, "authProfile.tokenRef") }),
  };
}

function parseCapabilities(value: unknown): AgentCapabilitySet {
  const record = requiredRecord(value, "agentCapabilities");
  return {
    mcpTools: requiredArray(record.mcpTools, "agentCapabilities.mcpTools").map((item) => {
      const tool = requiredRecord(item, "agentCapabilities.mcpTools[]");
      return {
        id: nonEmptyString(tool.id, "mcpTool.id"),
        permission: oneOf(tool.permission, ["allow", "ask", "always_ask", "deny"] as const, "mcpTool.permission"),
      };
    }),
    skills: stringArray(record.skills, "agentCapabilities.skills"),
    resources: requiredArray(record.resources, "agentCapabilities.resources").map((item) => {
      const resource = requiredRecord(item, "agentCapabilities.resources[]");
      return {
        serverId: identifier(resource.serverId, "resource.serverId"),
        uri: nonEmptyString(resource.uri, "resource.uri"),
        mode: oneOf(resource.mode, ["metadata", "preload"] as const, "resource.mode"),
      };
    }),
  };
}

function secretMap(value: unknown, label: string): Record<string, SecretRef> {
  const record = requiredRecord(value, label);
  return Object.fromEntries(Object.entries(record).map(([key, ref]) => [key, parseSecretRef(ref, `${label}.${key}`)]));
}

function parseSecretRef(value: unknown, label: string): SecretRef {
  const record = requiredRecord(value, label);
  return {
    provider: oneOf(record.provider, ["env", "keychain"] as const, `${label}.provider`),
    key: nonEmptyString(record.key, `${label}.key`),
  };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  return requiredArray(value, label).map((item, index) => nonEmptyString(item, `${label}[${index}]`));
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value;
}

function identifier(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(result)) throw new Error(`${label} 格式无效`);
  return result;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} 必须是布尔值`);
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${label} 必须是 ${values.join("/")}`);
  }
  return value as T[number];
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} 重复: ${value}`);
    seen.add(value);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
