import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { McpConfigStore } from "../../src/mcp/mcp-config-store.js";

describe("McpConfigStore SecretRef migration", () => {
  it("把历史 keychain 引用归一化为 managed，并以新格式保存", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-mcp-secret-ref-"));
    const file = join(dir, "mcp.json");
    await writeFile(file, `${JSON.stringify({
      version: 1,
      servers: [],
      authProfiles: [{
        id: "legacy-auth",
        kind: "bearer",
        tokenRef: { provider: "keychain", key: "models-kindergarten/legacy-token" },
      }],
      agentCapabilities: { mcpTools: [], skills: [], resources: [] },
    })}\n`, { encoding: "utf8", mode: 0o600 });

    const store = new McpConfigStore(file);
    const migrated = await store.load();
    expect(migrated.authProfiles[0]?.tokenRef).toEqual({
      provider: "managed",
      key: "models-kindergarten/legacy-token",
    });

    await store.save(migrated);
    expect(await readFile(file, "utf8")).not.toContain('"keychain"');
  });
});
