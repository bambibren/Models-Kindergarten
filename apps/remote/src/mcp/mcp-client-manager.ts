import { createHash } from "node:crypto";
import type { AuthProvider } from "@modelcontextprotocol/client";
import { canonicalJson } from "../tools/tool-registry.js";
import { McpAuthBroker } from "./mcp-auth-broker.js";
import type { McpConfigStore } from "./mcp-config-store.js";
import type {
  McpCapabilitySnapshot,
  McpConfigDocument,
  McpConnectedClient,
  McpConnector,
  McpFailure,
  McpInteractionPort,
  McpResourceReadResult,
  McpServerConfig,
  McpServerState,
  McpToolCallResult,
  SecretRef,
} from "./mcp-types.js";
import type { SecretStore } from "./secret-store.js";

/** 一个 Manager 对应一个 MCP Host；每个 Server 始终持有独立 Client。 */
export class McpClientManager {
  private document?: McpConfigDocument;
  private readonly clients = new Map<string, McpConnectedClient>();
  private readonly states = new Map<string, McpServerState>();
  private readonly snapshots = new Map<string, McpCapabilitySnapshot>();

  constructor(
    private readonly store: McpConfigStore,
    private readonly secrets: SecretStore,
    private readonly connector: McpConnector,
  ) {}

  async initialize(): Promise<McpConfigDocument> {
    if (this.document) return structuredClone(this.document);
    const document = await this.store.load();
    this.document = document;
    await Promise.all(document.servers.filter((server) => server.enabled).map(async (server) => {
      await this.connectManaged(server, false);
    }));
    return structuredClone(document);
  }

  config(): McpConfigDocument {
    if (!this.document) throw new Error("MCP Client Manager 尚未初始化");
    return structuredClone(this.document);
  }

  serverConfig(serverId: string): McpServerConfig {
    const server = this.document?.servers.find((item) => item.id === serverId);
    if (!server) throw new Error(`MCP Server 配置不存在: ${serverId}`);
    return structuredClone(server);
  }

  serverStates(): McpServerState[] {
    return this.configuredOrder(this.states).map((item) => structuredClone(item));
  }

  capabilitySnapshots(): McpCapabilitySnapshot[] {
    return this.configuredOrder(this.snapshots).map((item) => structuredClone(item));
  }

  async testCandidate(server: McpServerConfig): Promise<McpCapabilitySnapshot> {
    if (server.transport.kind !== "streamable_http" || server.transport.authProfileId || server.transport.headerRefs) {
      throw new Error("MCP candidate 只支持无鉴权 streamable_http");
    }
    const client = await this.connector.connect(server, undefined, {});
    try {
      return await discover(server.id, client);
    } finally {
      await client.close();
    }
  }

  async installNoAuth(server: McpServerConfig): Promise<McpCapabilitySnapshot> {
    await this.initialize();
    if (server.transport.kind !== "streamable_http" || server.transport.authProfileId || server.transport.headerRefs) {
      throw new Error("安装入口只支持无鉴权 streamable_http");
    }
    if (this.document!.servers.some((item) => item.id === server.id)) throw new Error(`MCP Server 已存在: ${server.id}`);
    const previous = structuredClone(this.document!);
    this.document = { ...this.document!, servers: [...this.document!.servers, structuredClone(server)] };
    await this.store.save(this.document);
    try {
      await this.connectManaged(server, true);
    } catch (error) {
      await this.disconnectClient(server.id);
      this.states.delete(server.id);
      this.snapshots.delete(server.id);
      this.document = previous;
      await this.store.save(previous);
      throw error;
    }
    const snapshot = this.snapshots.get(server.id);
    if (!snapshot) throw new Error(`MCP Server ${server.id} 安装后未就绪`);
    return structuredClone(snapshot);
  }

  async reconnect(serverId: string): Promise<McpCapabilitySnapshot> {
    const server = this.serverConfig(serverId);
    await this.disconnectClient(serverId);
    await this.connectManaged(server, true);
    const snapshot = this.snapshots.get(serverId);
    if (!snapshot) throw new Error(`MCP Server ${serverId} 重连失败`);
    return structuredClone(snapshot);
  }

  async setEnabled(serverId: string, enabled: boolean): Promise<void> {
    const current = this.serverConfig(serverId);
    const previous = structuredClone(this.document!);
    const next = {
      ...this.document!,
      servers: this.document!.servers.map((item) => item.id === serverId ? { ...item, enabled } : item),
    };
    this.document = next;
    await this.store.save(next);
    if (!enabled) {
      await this.disconnectClient(serverId);
      this.states.set(serverId, { serverId, status: "disconnected" });
    } else {
      try {
        await this.connectManaged({ ...current, enabled: true }, true);
      } catch (error) {
        this.document = previous;
        await this.store.save(previous);
        throw error;
      }
    }
  }

  async uninstall(serverId: string): Promise<void> {
    this.serverConfig(serverId);
    await this.disconnectClient(serverId);
    this.states.delete(serverId);
    this.snapshots.delete(serverId);
    this.document = {
      ...this.document!,
      servers: this.document!.servers.filter((item) => item.id !== serverId),
      agentCapabilities: {
        ...this.document!.agentCapabilities,
        mcpTools: this.document!.agentCapabilities.mcpTools.filter((item) => !item.id.startsWith(`mcp:${serverId}:tool:`)),
        resources: this.document!.agentCapabilities.resources.filter((item) => item.serverId !== serverId),
      },
    };
    await this.store.save(this.document);
  }

  async callTool(
    serverId: string,
    remoteName: string,
    args: Record<string, unknown>,
    toolCallId: string,
    interaction: McpInteractionPort,
    signal: AbortSignal,
  ): Promise<McpToolCallResult> {
    try {
      return await this.client(serverId).callTool(
        remoteName,
        args,
        toolCallId,
        interaction,
        signal,
      );
    } catch (error) {
      throw mcpError(error, "remote_tool");
    }
  }

  async readResource(
    serverId: string,
    uri: string,
    signal: AbortSignal,
  ): Promise<McpResourceReadResult> {
    try {
      return await this.client(serverId).readResource(uri, signal);
    } catch (error) {
      throw mcpError(error, "protocol");
    }
  }

  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map((client) => client.close()));
    for (const state of this.states.values()) state.status = "disconnected";
  }

  private async connectManaged(server: McpServerConfig, failLoudly: boolean): Promise<void> {
    this.states.set(server.id, { serverId: server.id, status: "connecting" });
    try {
      const headers = await this.resolveHeaders(
        server.transport.kind === "streamable_http" ? server.transport.headerRefs : undefined,
      );
      const auth = new McpAuthBroker(this.document?.authProfiles ?? [], this.secrets);
      const provider: AuthProvider | undefined = server.transport.kind === "streamable_http"
        ? auth.provider(server.transport.authProfileId)
        : undefined;
      const client = await this.connector.connect(server, provider, headers);
      const snapshot = await discover(server.id, client);
      this.clients.set(server.id, client);
      this.snapshots.set(server.id, snapshot);
      this.states.set(server.id, {
        serverId: server.id,
        status: "ready",
        protocolEra: client.protocolEra,
        connectedAt: snapshot.fetchedAt,
      });
    } catch (error) {
      const failure = toMcpFailure(error, "discovery");
      this.states.set(server.id, {
        serverId: server.id,
        status: failure.category === "authentication" ? "auth_required" : "failed",
        lastError: failure,
      });
      if (failLoudly) throw new McpRuntimeError(failure, { cause: error });
      console.warn(`MCP Server ${server.id} 不可用：${failure.message}`);
    }
  }

  private async disconnectClient(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    this.clients.delete(serverId);
    this.snapshots.delete(serverId);
    if (client) await client.close();
  }

  private client(serverId: string): McpConnectedClient {
    const client = this.clients.get(serverId);
    if (client) return client;
    const state = this.states.get(serverId);
    throw mcpError(
      state?.lastError?.message ?? `MCP Server ${serverId} 未连接`,
      state?.lastError?.category ?? "transport",
    );
  }

  private async resolveHeaders(
    refs: Record<string, SecretRef> | undefined,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    for (const [name, ref] of Object.entries(refs ?? {})) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
        throw new Error(`MCP Header 名称无效: ${name}`);
      }
      if (name.toLowerCase() === "authorization") {
        throw new Error("Authorization Header 必须通过 authProfile 配置");
      }
      headers[name] = await this.secrets.read(ref);
    }
    return headers;
  }

  /** 并行连接只缩短启动时间，对模型暴露的能力顺序始终服从配置顺序。 */
  private configuredOrder<T>(values: Map<string, T>): T[] {
    return (this.document?.servers ?? []).flatMap((server) => {
      const value = values.get(server.id);
      return value === undefined ? [] : [value];
    });
  }
}

async function discover(serverId: string, client: McpConnectedClient): Promise<McpCapabilitySnapshot> {
  const [tools, resources, prompts] = await Promise.all([
    client.listTools(),
    client.listResources(),
    client.listPrompts(),
  ]);
  const fetchedAt = Date.now();
  const revision = createHash("sha256").update(canonicalJson({
    era: client.protocolEra,
    tools,
    resources,
    prompts,
  })).digest("hex");
  return {
    serverId,
    revision,
    fetchedAt,
    ...(client.instructions ? { instructions: client.instructions } : {}),
    tools,
    resources,
    prompts,
  };
}

export class McpRuntimeError extends Error {
  constructor(readonly failure: McpFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "McpRuntimeError";
  }
}

function mcpError(error: unknown, fallback: McpFailure["category"]): McpRuntimeError {
  if (error instanceof McpRuntimeError) return error;
  return new McpRuntimeError(toMcpFailure(error, fallback), { cause: error });
}

function toMcpFailure(error: unknown, fallback: McpFailure["category"]): McpFailure {
  if (error instanceof McpRuntimeError) return error.failure;
  if (error instanceof DOMException && error.name === "AbortError") {
    return { category: "cancelled", message: "MCP 调用已取消", retryable: false };
  }
  const message = errorText(error);
  const lower = `${error instanceof Error ? error.name : ""} ${message}`.toLowerCase();
  if (/unauthor|forbidden|oauth|token|credential|auth/.test(lower)) {
    return { category: "authentication", message, retryable: false };
  }
  if (/schema|argument|invalid params|validation/.test(lower)) {
    return { category: "validation", message, retryable: false };
  }
  if (/timeout|econn|network|fetch|socket|closed/.test(lower)) {
    return { category: "transport", message, retryable: true };
  }
  return { category: fallback, message, retryable: false };
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return String(value);
}
