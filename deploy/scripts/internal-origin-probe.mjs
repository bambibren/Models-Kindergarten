/** 在 mk-app 容器中执行，只验证 Docker 内部服务地址，不经过公网域名或宿主机端口。 */
export const internalOriginProbeSource = String.raw`
const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("内部服务配置缺失：" + name);
  return value.replace(/\/$/, "");
};
const results = [];
const request = async (name, url, expectedType) => {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(name + " 返回 HTTP " + response.status);
  const contentType = response.headers.get("content-type") ?? "";
  if (expectedType && !contentType.toLowerCase().includes(expectedType)) {
    throw new Error(name + " Content-Type 无效：" + contentType);
  }
  results.push({ name, status: response.status, contentType });
  return response;
};
const webOrigin = required("MK_WEB_INTERNAL_ORIGIN");
const skillList = await request("Web Skill list", webOrigin + "/skills", "application/json").then((response) => response.json());
const skillName = skillList.skills?.find((item) => typeof item?.name === "string")?.name;
if (!skillName) throw new Error("Web Skill list 没有可验证的资源");
const bundle = await request("Web Skill bundle", webOrigin + "/skills/" + encodeURIComponent(skillName), "application/vnd.mk.skill+json").then((response) => response.json());
if (bundle.schemaVersion !== 1 || bundle.kind !== "mk-skill-bundle" || bundle.name !== skillName || !Array.isArray(bundle.files)) {
  throw new Error("Web Skill bundle 结构无效");
}
await request("Runtime", required("MK_RUNTIME_INTERNAL_ORIGIN") + "/health/ready", "application/json");
await request("ONLYOFFICE", required("MK_ONLYOFFICE_INTERNAL_ORIGIN") + "/healthcheck", null);
process.stdout.write(JSON.stringify(results));
`;
