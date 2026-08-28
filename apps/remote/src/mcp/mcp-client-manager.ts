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
import { PRODUCT_CONFIG } from "@kindergarten/contracts";

/** 一个 Manager 对应一个 MCP Host；每个 Server 始终持有独立 Client。 */
export class McpClientManager {
  private document?: McpConfigDocument;
  private readonly clients = new Map<string, McpConnectedClient>();
  private readonly connecting = new Set<string>();
  private readonly states = new Map<string, McpServerState>();
  private readonly snapshots = new Map<string, McpCapabilitySnapshot>();

  /** 初始化「McpClientManager」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly store: McpConfigStore,
    private readonly secrets: SecretStore,
    private readonly connector: McpConnector,
  ) {}

  /** 加载配置并连接容量内的 enabled Server；超限项保留配置并标记 `capacity_blocked`。 */
async initialize(): Promise<McpConfigDocument> {
    if (this.document) return structuredClone(this.document);
    const document = await this.store.load();
    this.document = document;
    await Promise.all(document.servers.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(server) => server.enabled).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
async (server) => {
      await this.connectManaged(server, false);
    }));
    return structuredClone(document);
  }

  /** 执行「config」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
config(): McpConfigDocument {
    if (!this.document) throw new Error("MCP Client Manager 尚未初始化");
    return structuredClone(this.document);
  }

  /** 执行「serverConfig」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
serverConfig(serverId: string): McpServerConfig {
    const server = this.document?.servers.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.id === serverId);
    if (!server) throw new Error(`MCP Server 配置不存在: ${serverId}`);
    return structuredClone(server);
  }

  /** 执行「serverStates」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
serverStates(): McpServerState[] {
    return this.configuredOrder(this.states).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => structuredClone(item));
  }

  /** 执行「capabilitySnapshots」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
capabilitySnapshots(): McpCapabilitySnapshot[] {
    return this.configuredOrder(this.snapshots).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => structuredClone(item));
  }

  /** 执行「testCandidate」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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

  /** 执行「installNoAuth」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async installNoAuth(server: McpServerConfig): Promise<McpCapabilitySnapshot> {
    await this.initialize();
    if (server.transport.kind !== "streamable_http" || server.transport.authProfileId || server.transport.headerRefs) {
      throw new Error("安装入口只支持无鉴权 streamable_http");
    }
    if (this.document!.servers.length >= PRODUCT_CONFIG.capacity.maxMcpInstallations) {
      throw new Error(`MCP Installation 已达到 ${PRODUCT_CONFIG.capacity.maxMcpInstallations} 条容量上限`);
    }
    if (this.document!.servers.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.id === server.id)) throw new Error(`MCP Server 已存在: ${server.id}`);
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

  /** 执行「reconnect」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async reconnect(serverId: string): Promise<McpCapabilitySnapshot> {
    const server = this.serverConfig(serverId);
    await this.disconnectClient(serverId);
    await this.connectManaged(server, true);
    const snapshot = this.snapshots.get(serverId);
    if (!snapshot) throw new Error(`MCP Server ${serverId} 重连失败`);
    return structuredClone(snapshot);
  }

  /** 更新「setEnabled」对应状态，并保持写入顺序、原子性与容量约束。 */
async setEnabled(serverId: string, enabled: boolean): Promise<void> {
    const current = this.serverConfig(serverId);
    const previous = structuredClone(this.document!);
    const next = {
      ...this.document!,
      servers: this.document!.servers.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.id === serverId ? { ...item, enabled } : item),
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

  /** 先关闭 Client，再删除状态、快照和 Agent 能力引用，避免卸载后残留连接对象。 */
async uninstall(serverId: string): Promise<void> {
    this.serverConfig(serverId);
    await this.disconnectClient(serverId);
    this.states.delete(serverId);
    this.snapshots.delete(serverId);
    this.document = {
      ...this.document!,
      servers: this.document!.servers.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.id !== serverId),
      agentCapabilities: {
        ...this.document!.agentCapabilities,
        mcpTools: this.document!.agentCapabilities.mcpTools.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !item.id.startsWith(`mcp:${serverId}:tool:`)),
        resources: this.document!.agentCapabilities.resources.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.serverId !== serverId),
      },
    };
    await this.store.save(this.document);
  }

  /** 执行「callTool」主流程，传播取消与失败并在结束时清理临时资源。 */
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

  /** 读取「readResource」所需数据，并遵守作用域、分页与容量边界。 */
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

  /** 释放或删除「close」对应资源，重复调用仍保持安全。 */
async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(client) => client.close()));
    for (const state of this.states.values()) state.status = "disconnected";
  }

  /** 在 Client+connecting 总数上限内建立连接；失败路径关闭半连接并清理 connecting。 */
private async connectManaged(server: McpServerConfig, failLoudly: boolean): Promise<void> {
    if (
      !this.clients.has(server.id) &&
      !this.connecting.has(server.id) &&
      this.clients.size + this.connecting.size >= PRODUCT_CONFIG.capacity.maxEnabledMcpClients
    ) {
      this.states.set(server.id, {
        serverId: server.id,
        status: "capacity_blocked",
        lastError: {
          category: "configuration",
          message: `已启用 MCP Client 达到 ${PRODUCT_CONFIG.capacity.maxEnabledMcpClients} 个容量上限`,
          retryable: false,
        },
      });
      if (failLoudly) throw new Error(`已启用 MCP Client 达到 ${PRODUCT_CONFIG.capacity.maxEnabledMcpClients} 个容量上限`);
      return;
    }
    this.connecting.add(server.id);
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
    } finally {
      this.connecting.delete(server.id);
    }
  }

  /** 执行「disconnectClient」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private async disconnectClient(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    this.clients.delete(serverId);
    this.snapshots.delete(serverId);
    if (client) await client.close();
  }

  /** 执行「client」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private client(serverId: string): McpConnectedClient {
    const client = this.clients.get(serverId);
    if (client) return client;
    const state = this.states.get(serverId);
    throw mcpError(
      state?.lastError?.message ?? `MCP Server ${serverId} 未连接`,
      state?.lastError?.category ?? "transport",
    );
  }

  /** 执行「resolveHeaders」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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
    return (this.document?.servers ?? []).flatMap(/** 执行「configuredOrder」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(server) => {
      const value = values.get(server.id);
      return value === undefined ? [] : [value];
    });
  }
}

/** 执行「discover」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async function discover(serverId: string, client: McpConnectedClient): Promise<McpCapabilitySnapshot> {
  const [tools, resources, prompts] = await Promise.all([
    client.listTools(),
    client.listResources(),
    client.listPrompts(),
  ]);
  const fetchedAt = Date.now();
  if (tools.length > PRODUCT_CONFIG.capacity.maxMcpToolsPerServer) {
    throw new Error(`MCP Server ${serverId} 暴露 ${tools.length} 个 Tool，超过 ${PRODUCT_CONFIG.capacity.maxMcpToolsPerServer} 个上限`);
  }
  const descriptorBytes = Buffer.byteLength(JSON.stringify({
    instructions: client.instructions,
    tools,
    resources,
    prompts,
  }));
  if (descriptorBytes > PRODUCT_CONFIG.capacity.maxMcpDescriptorBytes) {
    throw new Error(`MCP Server ${serverId} 的能力描述为 ${descriptorBytes} 字节，超过 ${PRODUCT_CONFIG.capacity.maxMcpDescriptorBytes} 字节上限`);
  }
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

/** 描述「McpRuntimeError」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class McpRuntimeError extends Error {
  /** 初始化「McpRuntimeError」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(readonly failure: McpFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "McpRuntimeError";
  }
}

/** 执行「mcpError」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function mcpError(error: unknown, fallback: McpFailure["category"]): McpRuntimeError {
  if (error instanceof McpRuntimeError) return error;
  return new McpRuntimeError(toMcpFailure(error, fallback), { cause: error });
}

/** 根据已校验输入构建「toMcpFailure」结果，不额外持有调用方的大对象。 */
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

/** 把未知异常转换为「errorText」文本，避免错误序列化过程再次抛出。 */
function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return String(value);
}
