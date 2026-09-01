/** 上下文实验只在显式启用的 Web 构建中开放入口，未配置时继续保持产品默认关闭。 */
export function contextExperimentsEnabled(
  env: { VITE_ENABLE_CONTEXT_EXPERIMENTS?: string } = import.meta.env as ImportMetaEnv & { VITE_ENABLE_CONTEXT_EXPERIMENTS?: string },
): boolean {
  return env.VITE_ENABLE_CONTEXT_EXPERIMENTS === "true";
}
