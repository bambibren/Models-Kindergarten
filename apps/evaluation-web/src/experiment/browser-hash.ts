/** 根据已校验输入构建「createHash」结果，不额外持有调用方的大对象。 */
export async function createHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(byte) => byte.toString(16).padStart(2, "0")).join("");
}
