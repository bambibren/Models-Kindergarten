/** 在 mk-app 容器中执行，只验证 Docker 内部服务地址，不经过公网域名或宿主机端口。 */
export const internalOriginProbeSource = String.raw`
const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("内部服务配置缺失：" + name);
  return value.replace(/\/$/, "");
};
const checks = [
  ["Web Skills", required("MK_WEB_INTERNAL_ORIGIN") + "/skills/website-design-fast", "application/vnd.mk.skill+json"],
  ["Runtime", required("MK_RUNTIME_INTERNAL_ORIGIN") + "/health/ready", "application/json"],
  ["ONLYOFFICE", required("MK_ONLYOFFICE_INTERNAL_ORIGIN") + "/healthcheck", null],
];
const results = [];
for (const [name, url, expectedType] of checks) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(name + " 返回 HTTP " + response.status);
  const contentType = response.headers.get("content-type") ?? "";
  if (expectedType && !contentType.toLowerCase().includes(expectedType)) {
    throw new Error(name + " Content-Type 无效：" + contentType);
  }
  results.push({ name, status: response.status, contentType });
}
process.stdout.write(JSON.stringify(results));
`;
