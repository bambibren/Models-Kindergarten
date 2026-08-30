import { describe, expect, it } from "vitest";
import {
  assertImplementedDeploymentFeatures,
  readDeploymentConfig,
} from "../../src/config/deployment-config.js";

describe("deployment config", () => {
  it("本地源码默认只监听回环地址", () => {
    const config = readDeploymentConfig({}, "/tmp/mk-config-test", "/tmp/mk-workspace");
    expect(config).toMatchObject({
      profile: "local-source",
      host: "127.0.0.1",
      port: 7331,
      dataDir: "/tmp/mk-config-test/.data",
      authMode: "development",
      masterKeyFile: "/tmp/mk-workspace/.local/secrets/mk_master_key",
      credentialVaultFile: "/tmp/mk-config-test/.data/secure/credentials.enc",
    });
  });

  it("拒绝 local-source 监听公网地址", () => {
    expect(() => readDeploymentConfig({ HOST: "0.0.0.0" })).toThrow("local-source");
  });

  it("容器配置允许 0.0.0.0，但必须声明公开 Origin", () => {
    expect(() => readDeploymentConfig({ DEPLOYMENT_PROFILE: "docker-preview" })).toThrow("PUBLIC_ORIGIN");
    expect(readDeploymentConfig({
      DEPLOYMENT_PROFILE: "docker-preview",
      HOST: "0.0.0.0",
      PUBLIC_ORIGIN: "https://mk.localhost:8443",
    })).toMatchObject({
      host: "0.0.0.0",
      masterKeyFile: "/run/secrets/mk_master_key",
    });
  });

  it("显式路径覆盖自动选择结果", () => {
    expect(readDeploymentConfig({
      MASTER_KEY_FILE: "var/secrets/key",
      CREDENTIAL_VAULT_FILE: "var/data/credentials.enc",
    }, "/tmp/mk-config-test", "/tmp/mk-workspace")).toMatchObject({
      masterKeyFile: "/tmp/mk-workspace/var/secrets/key",
      credentialVaultFile: "/tmp/mk-config-test/var/data/credentials.enc",
    });
  });

  it("正式认证只允许 HTTPS 公开 Origin", () => {
    expect(() => assertImplementedDeploymentFeatures(readDeploymentConfig({
      DEPLOYMENT_PROFILE: "cloud",
      AUTH_MODE: "required",
      PUBLIC_ORIGIN: "http://mk.example.com",
    }))).toThrow("HTTPS");
    expect(() => assertImplementedDeploymentFeatures(readDeploymentConfig({
      DEPLOYMENT_PROFILE: "cloud",
      AUTH_MODE: "required",
      PUBLIC_ORIGIN: "https://mk.example.com",
    }))).not.toThrow();
  });
});
