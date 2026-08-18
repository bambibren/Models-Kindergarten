import { describe, expect, it } from "vitest";
import { ControlRouter } from "../../src/server/control-router.js";

describe("Artifact bundle route", () => {
  it("保留 Bundle 内的多层相对路径", () => {
    const router = new ControlRouter();
    const handler = () => undefined;
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

  it("非 Bundle 路由不会被通配符误匹配", () => {
    const router = new ControlRouter();
    router.register("GET", "/artifacts/:artifactId/bundle/*path", () => undefined);

    expect(router.match("GET", "/artifacts/artifact_12345678/preview")).toBeUndefined();
    expect(router.match("GET", "/artifacts/artifact_12345678/bundle")).toMatchObject({
      params: { artifactId: "artifact_12345678", path: "" },
    });
  });
});
