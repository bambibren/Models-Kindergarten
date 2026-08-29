import type { SecretRef } from "./mcp-types.js";

/** 描述「SecretStore」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SecretStore {
  read(ref: SecretRef): Promise<string>;
}

/** 只有控制面可持有写能力；Runtime 仍只依赖只读 SecretStore。 */
export interface WritableSecretStore extends SecretStore {
  write(ref: SecretRef, value: string): Promise<void>;
  delete(ref: SecretRef): Promise<void>;
}
