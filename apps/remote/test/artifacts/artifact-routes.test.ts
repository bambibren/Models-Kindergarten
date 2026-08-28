import { describe, expect, it } from "vitest";
import { ControlRouter } from "../../src/server/control-router.js";

describe("Artifact bundle route", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("保留 Bundle 内的多层相对路径", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const router = new ControlRouter();
    const handler = /** 构造「handler」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => undefined;
    router.register("GET", "/artifacts/:artifactId/bundle/*path", handler);

    const match = router.match("GET", "/artifacts/artifact_12345678/bundle/assets/scripts/app.js");

    expect(match).toEqual({
      handler,
      params: {
        artifactId: "artifact_12345678",
        path: "assets/scripts/app.js",
      },
    });
    expect(router.allowedMethods("/artifacts/artifact_12345678/bundle/assets/scripts/app.js")).toEqual(["GET"]);
  });

  it("非 Bundle 路由不会被通配符误匹配", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const router = new ControlRouter();
    router.register("GET", "/artifacts/:artifactId/bundle/*path", /** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
() => undefined);

    expect(router.match("GET", "/artifacts/artifact_12345678/preview")).toBeUndefined();
    expect(router.match("GET", "/artifacts/artifact_12345678/bundle")).toMatchObject({
      params: { artifactId: "artifact_12345678", path: "" },
    });
  });
});
