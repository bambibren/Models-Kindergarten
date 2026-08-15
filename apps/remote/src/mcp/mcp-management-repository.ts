import type { McpInstallationView, McpTestRecord } from "@kindergarten/contracts";
import { AtomicJsonStore } from "../storage/atomic-json-store.js";

export class McpManagementRepository {
  private readonly tests: AtomicJsonStore<McpTestRecord>;
  private readonly installations: AtomicJsonStore<McpInstallationView>;

  constructor(testsFile: string, installationsFile: string) {
    this.tests = new AtomicJsonStore({ file: testsFile, schemaVersion: 1, validate: isTest });
    this.installations = new AtomicJsonStore({ file: installationsFile, schemaVersion: 1, validate: isInstallation });
  }

  listTests(): Promise<McpTestRecord[]> { return this.tests.read(); }
  listInstallations(): Promise<McpInstallationView[]> { return this.installations.read(); }

  async getTest(id: string): Promise<McpTestRecord | undefined> {
    return (await this.tests.read()).find((item) => item.testId === id);
  }

  async getInstallation(id: string): Promise<McpInstallationView | undefined> {
    return (await this.installations.read()).find((item) => item.mcpInstallationId === id);
  }

  async putTest(value: McpTestRecord): Promise<void> {
    await this.tests.update((records) => [...records.filter((item) => item.testId !== value.testId), value]);
  }

  async putInstallation(value: McpInstallationView): Promise<void> {
    await this.installations.update((records) => [
      ...records.filter((item) => item.mcpInstallationId !== value.mcpInstallationId), value,
    ]);
  }

  async removeInstallation(id: string): Promise<void> {
    await this.installations.update((records) => records.filter((item) => item.mcpInstallationId !== id));
  }
}

function isTest(value: unknown): value is McpTestRecord {
  if (!record(value)) return false;
  return value.schemaVersion === 1 && typeof value.testId === "string" && typeof value.ownerId === "string" &&
    typeof value.candidateHash === "string" && record(value.candidate) && typeof value.state === "string" &&
    typeof value.createdAt === "string" && typeof value.expiresAt === "string";
}

function isInstallation(value: unknown): value is McpInstallationView {
  if (!record(value)) return false;
  return value.schemaVersion === 1 && typeof value.mcpInstallationId === "string" && typeof value.ownerId === "string" &&
    typeof value.name === "string" && typeof value.url === "string" && typeof value.state === "string" &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
