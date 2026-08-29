import type { SecretStore } from "../../src/mcp/secret-store.js";

/** 测试只需要环境引用时使用，避免构造真实文件 Vault。 */
export function testSecretStore(): SecretStore {
  return {
    read: async (ref) => {
      if (ref.provider !== "env") throw new Error(`测试 Secret 不存在: ${ref.key}`);
      const value = process.env[ref.key];
      if (!value) throw new Error(`环境 Secret 不存在: ${ref.key}`);
      return value;
    },
  };
}
