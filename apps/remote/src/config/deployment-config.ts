import { resolve } from "node:path";

export type DeploymentProfile = "local-source" | "docker-preview" | "cloud";
export type AuthMode = "development" | "required";
export type ManagedEndpointPolicy = "any-network" | "public-only";

/** Remote 启动时一次性读取并校验的部署配置；业务模块不再各自解释环境变量。 */
export interface DeploymentConfig {
  profile: DeploymentProfile;
  managedEndpointPolicy: ManagedEndpointPolicy;
  host: string;
  port: number;
  publicOrigin?: string;
  dataDir: string;
  sandboxDir: string;
  userSkillsDir: string;
  authMode: AuthMode;
  masterKeyFile: string;
  credentialVaultFile: string;
}

/** 把环境变量收敛成不可变配置，并在进程创建任何资源前拒绝危险组合。 */
export function readDeploymentConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  workspaceRoot = cwd,
): DeploymentConfig {
  const profile = oneOf(env.DEPLOYMENT_PROFILE ?? "local-source", [
    "local-source",
    "docker-preview",
    "cloud",
  ] as const, "DEPLOYMENT_PROFILE");
  const host = env.HOST ?? (profile === "local-source" ? "127.0.0.1" : "0.0.0.0");
  if (profile === "local-source" && !isLoopbackHost(host)) {
    throw new Error("local-source 部署配置只允许监听本机回环地址");
  }
  const publicOrigin = optionalOrigin(env.PUBLIC_ORIGIN);
  if (profile !== "local-source" && !publicOrigin) {
    throw new Error(`${profile} 部署配置必须提供 PUBLIC_ORIGIN`);
  }
  const dataDir = resolve(cwd, env.DATA_DIR ?? ".data");
  const masterKeyFile = resolve(
    workspaceRoot,
    env.MASTER_KEY_FILE ?? (profile === "local-source"
      ? ".local/secrets/mk_master_key"
      : "/run/secrets/mk_master_key"),
  );
  return {
    profile,
    managedEndpointPolicy: profile === "local-source" ? "any-network" : "public-only",
    host,
    port: positiveInteger(env.PORT, 7331, "PORT"),
    ...(publicOrigin ? { publicOrigin } : {}),
    dataDir,
    sandboxDir: resolve(cwd, env.SANDBOX_DIR ?? `${dataDir}/sandbox`),
    userSkillsDir: resolve(cwd, env.USER_SKILLS_DIR ?? `${dataDir}/skills`),
    authMode: oneOf(env.AUTH_MODE ?? "development", ["development", "required"] as const, "AUTH_MODE"),
    masterKeyFile,
    credentialVaultFile: resolve(cwd, env.CREDENTIAL_VAULT_FILE ?? `${dataDir}/secure/credentials.enc`),
  };
}

/** 当前阶段仍只有本地开发身份；required 用于阻止部署者误以为认证已经配置完成。 */
export function assertImplementedDeploymentFeatures(config: DeploymentConfig): void {
  if (config.authMode === "required" && !config.publicOrigin?.startsWith("https://")) {
    throw new Error("AUTH_MODE=required 必须使用 HTTPS PUBLIC_ORIGIN");
  }
}

export function isLoopbackHost(value: string): boolean {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`${label} 必须是 1 到 65535 的整数`);
  }
  return parsed;
}

function optionalOrigin(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : origin(value, "PUBLIC_ORIGIN");
}

function origin(value: string, label: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`${label} 必须是有效 URL Origin`); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error(`${label} 必须是没有路径、凭据、查询参数或片段的 HTTP(S) Origin`);
  }
  return parsed.origin;
}

function oneOf<const T extends readonly string[]>(value: string, allowed: T, label: string): T[number] {
  if (!allowed.includes(value)) throw new Error(`${label} 必须是 ${allowed.join("、")}`);
  return value as T[number];
}
