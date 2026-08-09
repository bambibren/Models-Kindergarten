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

export class SdkMcpConnector implements McpConnector {
  constructor(
    private readonly secrets: SecretStore,
    private readonly sandboxRoot: string,
  ) {}

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
    client.setRequestHandler("elicitation/create", async (request) => {
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
      (value) => { activeInteraction = value; },
    );
  }
}

class SdkConnectedClient implements McpConnectedClient {
  private readonly tools = new Map<string, Tool>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: Client,
    readonly protocolEra: "modern" | "legacy",
    readonly instructions: string | undefined,
    private readonly advertised: { tools: boolean; resources: boolean; prompts: boolean },
    private readonly setInteraction: (
      value: { port: McpInteractionPort; toolCallId: string } | undefined,
    ) => void,
  ) {}

  async listTools(): Promise<McpToolDescriptor[]> {
    if (!this.advertised.tools) return [];
    const result = await this.client.listTools();
    this.tools.clear();
    for (const tool of result.tools) this.tools.set(tool.name, tool);
    return result.tools.map((tool) => ({
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

  async listResources(): Promise<McpResourceDescriptor[]> {
    if (!this.advertised.resources) return [];
    const result = await this.client.listResources();
    return result.resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      ...(resource.title ? { title: resource.title } : {}),
      ...(resource.description ? { description: resource.description } : {}),
      ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    }));
  }

  async listPrompts(): Promise<McpPromptDescriptor[]> {
    if (!this.advertised.prompts) return [];
    const result = await this.client.listPrompts();
    return result.prompts.map((prompt) => ({
      name: prompt.name,
      ...(prompt.title ? { title: prompt.title } : {}),
      ...(prompt.description ? { description: prompt.description } : {}),
    }));
  }

  callTool(
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
    interaction: McpInteractionPort,
    signal: AbortSignal,
  ): Promise<McpToolCallResult> {
    return this.serial(async () => {
      this.setInteraction({ port: interaction, toolCallId });
      try {
        const result = await this.client.callTool(
          { name, arguments: args },
          {
            requestSignal: signal,
            ...(this.tools.get(name) ? { toolDefinition: this.tools.get(name)! } : {}),
          },
        );
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

  readResource(uri: string, signal: AbortSignal): Promise<McpResourceReadResult> {
    return this.serial(async () => {
      const result = await this.client.readResource({ uri }, { requestSignal: signal });
      return { contents: structuredClone(result.contents) as unknown[] };
    });
  }

  close(): Promise<void> {
    return this.client.close();
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
