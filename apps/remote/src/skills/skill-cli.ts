import { resolve } from "node:path";
import { SkillInstaller } from "./skill-installer.js";
import { SkillLockStore } from "./skill-lock-store.js";
import { configuredSkillResourceFetchBase, configuredSkillResourceOrigins, SkillSourceUrlPolicy } from "./skill-source-url.js";
import type { SkillInstallRequest } from "./skill-types.js";

const args = parseArgs(process.argv.slice(2));
const dataDir = resolve(process.env.DATA_DIR ?? ".data");
const installer = new SkillInstaller(
  resolve(process.env.USER_SKILLS_DIR ?? `${dataDir}/skills`),
  new SkillLockStore(resolve(process.env.SKILLS_LOCK_FILE ?? `${dataDir}/skills-lock.json`)),
  fetch,
  configuredSkillResourceFetchBase(process.env.SKILL_RESOURCE_FETCH_BASE),
);
const sourcePolicy = new SkillSourceUrlPolicy(configuredSkillResourceOrigins(process.env.SKILL_RESOURCE_ORIGINS));
const request = installRequest(args, sourcePolicy);
const record = await installer.install(request);
console.log(JSON.stringify({
  installed: true,
  name: record.name,
  contentHash: record.contentHash,
  source: record.source,
}, null, 2));

/** 执行「installRequest」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function installRequest(args: Map<string, string | true>, sourcePolicy: SkillSourceUrlPolicy): SkillInstallRequest {
  if (args.get("approve") !== true) throw new Error("必须提供 --approve 明确确认安装");
  const source = required(args, "source");
  if (source === "local") {
    return {
      approved: true,
      source: { kind: "local", path: required(args, "path") },
    };
  }
  if (source === "git") {
    const subdir = stringValue(args.get("subdir"));
    return {
      approved: true,
      source: {
        kind: "git",
        url: required(args, "url"),
        ref: required(args, "ref"),
        ...(subdir ? { subdir } : {}),
      },
    };
  }
  if (source === "resource") {
    const parsed = sourcePolicy.parse(required(args, "url"));
    if (parsed.kind !== "resource") throw new Error("--source resource 必须使用已配置的静态资源地址");
    return {
      approved: true,
      source: { kind: "resource", url: parsed.sourceUrl },
    };
  }
  throw new Error("--source 必须是 local、git 或 resource");
}

/** 校验并规范化「parseArgs」输入，非法数据直接返回明确错误。 */
function parseArgs(values: string[]): Map<string, string | true> {
  const result = new Map<string, string | true>();
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token?.startsWith("--")) throw new Error(`未知参数: ${token}`);
    const key = token.slice(2);
    if (key === "approve") {
      result.set(key, true);
      continue;
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} 缺少值`);
    result.set(key, value);
    index += 1;
  }
  return result;
}

/** 校验并取得「required」所需对象；缺失或归属不符时立即抛出明确错误。 */
function required(args: Map<string, string | true>, name: string): string {
  const value = stringValue(args.get(name));
  if (!value) throw new Error(`缺少 --${name}`);
  return value;
}

/** 执行「stringValue」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function stringValue(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
