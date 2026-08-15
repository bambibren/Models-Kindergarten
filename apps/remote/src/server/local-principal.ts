import type { LocalPrincipal } from "@kindergarten/contracts";

export const localPrincipal: LocalPrincipal = {
  schemaVersion: 1,
  principalId: "local-admin",
  kind: "local_admin",
};

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}
