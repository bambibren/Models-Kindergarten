import {
  Client,
  StreamableHTTPClientTransport,
  type AuthProvider,
  type ContentBlock,
  type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createMcpFetch } from "./mcp-network-policy.js";
import { stdioParameters } from "./mcp-process-policy.js";
import type {
  McpConnectedClient,
  McpConnector,
  McpInteractionPort,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpResourceReadResult,
  McpServerConfig,
  McpToolCallResult,
  McpToolDescriptor,
} from "./mcp-types.js";
import type { SecretStore } from "./secret-store.js";
import { PRODUCT_CONFIG } from "@kindergarten/contracts";

/** 描述「SdkMcpConnector」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class SdkMcpConnector implements McpConnector {
  /** 初始化「SdkMcpConnector」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly secrets: SecretStore,
    private readonly sandboxRoot: string,
  ) {}

  /** 执行「connect」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async connect(
    server: McpServerConfig,
    auth: AuthProvider | undefined,
    headers: Record<string, string>,
  ): Promise<McpConnectedClient> {
    let activeInteraction: { port: McpInteractionPort; toolCallId: string } | undefined;
    const client = new Client(
      { name: "models-kindergarten", version: "0.4.0" },
      {
        capabilities: { elicitation: { form: {}, url: {} } },
        versionNegotiation: { mode: "auto" },
        inputRequired: { autoFulfill: true, maxRounds: 4 },
        enforceStrictCapabilities: false,
        defaultCacheTtlMs: 60_000,
      },
    );
    client.setRequestHandler("elicitation/create", /** 执行「connect」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async (request) => {
      if (!activeInteraction) {
        return { action: "cancel" as const };
      }
      const params = request.params;
      const question = params.mode === "url"
        ? `${params.message}\n请在浏览器完成：${params.url}`
        : params.message;
      const answer = await activeInteraction.port.askUser(question, activeInteraction.toolCallId);
      if (params.mode === "url") return { action: "accept" as const };
      const properties = Object.keys(params.requestedSchema.properties);
      const key = params.requestedSchema.required?.[0] ?? properties[0] ?? "answer";
      return { action: "accept" as const, content: { [key]: answer } };
    });

    const transport = server.transport.kind === "stdio"
      ? new StdioClientTransport(await stdioParameters(server, this.secrets, this.sandboxRoot))
      : new StreamableHTTPClientTransport(new URL(server.transport.url), {
          ...(auth ? { authProvider: auth } : {}),
          requestInit: { headers },
          fetch: createMcpFetch(server.transport.allowPrivateNetwork === true),
          onInsufficientScope: "throw",
          maxStepUpRetries: 0,
        });
    await client.connect(transport);
    const era = client.getProtocolEra();
    if (!era) throw new Error(`MCP Server ${server.id} 未完成协议协商`);
    const capabilities = client.getServerCapabilities();
    return new SdkConnectedClient(
      client,
      era,
      client.getInstructions(),
      {
        tools: capabilities?.tools !== undefined,
        resources: capabilities?.resources !== undefined,
        prompts: capabilities?.prompts !== undefined,
      },
      /** 执行「connect」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(value) => { activeInteraction = value; },
    );
  }
}

class SdkConnectedClient implements McpConnectedClient {
  private readonly tools = new Map<string, Tool>();
  private queue: Promise<void> = Promise.resolve();

  /** 初始化「SdkConnectedClient」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly client: Client,
    readonly protocolEra: "modern" | "legacy",
    readonly instructions: string | undefined,
    private readonly advertised: { tools: boolean; resources: boolean; prompts: boolean },
    private readonly setInteraction: (
      value: { port: McpInteractionPort; toolCallId: string } | undefined,
    ) => void,
  ) {}

  /** 读取「listTools」所需数据，并遵守作用域、分页与容量边界。 */
async listTools(): Promise<McpToolDescriptor[]> {
    if (!this.advertised.tools) return [];
    const result = await this.client.listTools();
    this.tools.clear();
    for (const tool of result.tools) this.tools.set(tool.name, tool);
    return result.tools.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(tool) => ({
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: structuredClone(tool.inputSchema) as Record<string, unknown>,
      ...(tool.outputSchema
        ? { outputSchema: structuredClone(tool.outputSchema) as Record<string, unknown> }
        : {}),
      ...(tool.annotations ? {
        annotations: {
          ...(tool.annotations.readOnlyHint === undefined ? {} : { readOnlyHint: tool.annotations.readOnlyHint }),
          ...(tool.annotations.destructiveHint === undefined ? {} : { destructiveHint: tool.annotations.destructiveHint }),
          ...(tool.annotations.openWorldHint === undefined ? {} : { openWorldHint: tool.annotations.openWorldHint }),
        },
      } : {}),
    }));
  }

  /** 读取「listResources」所需数据，并遵守作用域、分页与容量边界。 */
async listResources(): Promise<McpResourceDescriptor[]> {
    if (!this.advertised.resources) return [];
    const result = await this.client.listResources();
    return result.resources.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(resource) => ({
      uri: resource.uri,
      name: resource.name,
      ...(resource.title ? { title: resource.title } : {}),
      ...(resource.description ? { description: resource.description } : {}),
      ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    }));
  }

  /** 读取「listPrompts」所需数据，并遵守作用域、分页与容量边界。 */
async listPrompts(): Promise<McpPromptDescriptor[]> {
    if (!this.advertised.prompts) return [];
    const result = await this.client.listPrompts();
    return result.prompts.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(prompt) => ({
      name: prompt.name,
      ...(prompt.title ? { title: prompt.title } : {}),
      ...(prompt.description ? { description: prompt.description } : {}),
    }));
  }

  /** 执行「callTool」主流程，传播取消与失败并在结束时清理临时资源。 */
callTool(
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
    interaction: McpInteractionPort,
    signal: AbortSignal,
  ): Promise<McpToolCallResult> {
    return this.serial(/** 执行「callTool」主流程，传播取消与失败并在结束时清理临时资源。 */
async () => {
      this.setInteraction({ port: interaction, toolCallId });
      try {
        const result = await this.client.callTool(
          { name, arguments: args },
          {
            requestSignal: signal,
            ...(this.tools.get(name) ? { toolDefinition: this.tools.get(name)! } : {}),
          },
        );
        assertMcpPayload("MCP Tool 结果", result, result.content.length);
        return {
          isError: result.isError === true,
          ...(result.structuredContent === undefined
            ? {}
            : { structuredContent: structuredClone(result.structuredContent) }),
          content: structuredClone(result.content) as ContentBlock[],
        };
      } finally {
        this.setInteraction(undefined);
      }
    });
  }

  /** 读取「readResource」所需数据，并遵守作用域、分页与容量边界。 */
readResource(uri: string, signal: AbortSignal): Promise<McpResourceReadResult> {
    return this.serial(/** 读取「readResource」所需数据，并遵守作用域、分页与容量边界。 */
async () => {
      const result = await this.client.readResource({ uri }, { requestSignal: signal });
      assertMcpPayload("MCP Resource 结果", result, result.contents.length);
      return { contents: structuredClone(result.contents) as unknown[] };
    });
  }

  /** 释放或删除「close」对应资源，重复调用仍保持安全。 */
close(): Promise<void> {
    return this.client.close();
  }

  /** 执行「serial」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private async serial<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/**
 * MCP SDK 已经把 wire 数据解析为对象；Remote 必须在第一次 clone 前拒绝超大对象，
 * 否则 `structuredClone` 会瞬间再制造一份同等大小的堆对象。
 */
function assertMcpPayload(label: string, value: unknown, blocks: number): void {
  if (blocks > PRODUCT_CONFIG.mcp.maxResultBlocks) {
    throw new Error(`${label}包含 ${blocks} 个内容块，超过 ${PRODUCT_CONFIG.mcp.maxResultBlocks} 个上限`);
  }
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value));
  } catch (error) {
    throw new Error(`${label}无法安全序列化`, { cause: error });
  }
  if (bytes > PRODUCT_CONFIG.mcp.maxResultBytes) {
    throw new Error(`${label}为 ${bytes} 字节，超过 ${PRODUCT_CONFIG.mcp.maxResultBytes} 字节上限`);
  }
}
