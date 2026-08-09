import type { AuthProvider } from "@modelcontextprotocol/client";
import type { McpAuthProfile } from "./mcp-types.js";
import type { SecretStore } from "./secret-store.js";

/**
 * AuthBroker 只向 SDK 提供短生命周期的 Token 读取函数。OAuth 浏览器授权属于
 * 独立管理流程；当前最小链路消费预先安全保存的 Access Token，不在聊天中传 Token。
 */
export class McpAuthBroker {
  constructor(
    private readonly profiles: McpAuthProfile[],
    private readonly secrets: SecretStore,
  ) {}

  provider(profileId: string | undefined): AuthProvider | undefined {
    if (!profileId) return undefined;
    const profile = this.profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error(`MCP 鉴权配置不存在: ${profileId}`);
    if (profile.kind === "none") return undefined;
    if (!profile.tokenRef) throw new Error(`MCP 鉴权配置缺少 tokenRef: ${profileId}`);
    return {
      token: () => this.secrets.read(profile.tokenRef!),
    };
  }
}
