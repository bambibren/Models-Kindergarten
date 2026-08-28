import type { AuthProvider } from "@modelcontextprotocol/client";
import type { McpAuthProfile } from "./mcp-types.js";
import type { SecretStore } from "./secret-store.js";

/**
 * AuthBroker 只向 SDK 提供短生命周期的 Token 读取函数。OAuth 浏览器授权属于
 * 独立管理流程；当前最小链路消费预先安全保存的 Access Token，不在聊天中传 Token。
 */
export class McpAuthBroker {
  /** 初始化「McpAuthBroker」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly profiles: McpAuthProfile[],
    private readonly secrets: SecretStore,
  ) {}

  /** 执行「provider」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
provider(profileId: string | undefined): AuthProvider | undefined {
    if (!profileId) return undefined;
    const profile = this.profiles.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.id === profileId);
    if (!profile) throw new Error(`MCP 鉴权配置不存在: ${profileId}`);
    if (profile.kind === "none") return undefined;
    if (!profile.tokenRef) throw new Error(`MCP 鉴权配置缺少 tokenRef: ${profileId}`);
    return {
      token: /** 根据已校验输入构建「token」结果，不额外持有调用方的大对象。 */
() => this.secrets.read(profile.tokenRef!),
    };
  }
}
