import { describe, expect, it } from "vitest";
import { ModelStudentCatalog } from "../../src/model/model-student-catalog.js";
import { FixtureProvider } from "../../src/model/fixture-provider.js";

describe("ModelStudentCatalog zero-model startup", () => {
  it("允许空目录启动且不存在隐式默认 Provider", () => {
    const catalog = new ModelStudentCatalog();
    expect(catalog.all()).toEqual([]);
    expect(catalog.runtimeProviderCount).toBe(0);
    expect(() => catalog.requireProvider("missing")).toThrow("不存在");
  });

  it("停用后保留摘要但不再解析 Provider", () => {
    const provider = new FixtureProvider();
    const catalog = new ModelStudentCatalog();
    catalog.register(provider, { initialStatus: "ready" });
    catalog.deactivate(provider.student.id, "已停用");

    expect(catalog.get(provider.student.id)).toMatchObject({
      status: "unavailable",
      statusMessage: "已停用",
      deletable: true,
    });
    expect(catalog.provider(provider.student.id, false)).toBeUndefined();
  });

  it("用户入园模型只向所属账号解析，共享系统模型仍可被所有账号读取", () => {
    const owned = new FixtureProvider();
    const catalog = new ModelStudentCatalog();
    catalog.register(owned, { initialStatus: "ready", ownerId: "owner-a" });

    expect(catalog.isReady(owned.student.id, "owner-a")).toBe(true);
    expect(catalog.isReady(owned.student.id, "owner-b")).toBe(false);
    expect(catalog.get(owned.student.id, "owner-b")).toBeUndefined();
    expect(() => catalog.requireProvider(owned.student.id, "owner-b")).toThrow("不存在");
  });
});
