import type { ControlRouter } from "../server/control-router.js";
import { ApiProblemError } from "../server/api-problem.js";
import type { ArtifactService } from "./artifact-service.js";
import type { OnlyOfficePreviewService } from "./onlyoffice-preview.js";

export function registerArtifactRoutes(router: ControlRouter, service: ArtifactService, onlyOffice?: OnlyOfficePreviewService): void {
  router.register("GET", "/artifacts", ({ url, principal }) => {
    const state = url.searchParams.get("state");
    return service.list(principal.principalId, {
      ...(url.searchParams.has("query") ? { query: url.searchParams.get("query") ?? "" } : {}),
      ...(state === "active" || state === "archived" || state === "all" ? { state } : {}),
    }).then((items) => ({ items }));
  });
  router.register("GET", "/artifacts/:artifactId", ({ params, principal }) =>
    service.get(params.artifactId ?? "", principal.principalId));
  router.register("GET", "/artifacts/:artifactId/preview", ({ params, principal, url }) =>
    service.preview(params.artifactId ?? "", principal.principalId, `${url.protocol}//${url.host}/api/control/v1`));
  if (onlyOffice) {
    router.register("GET", "/artifacts/:artifactId/pptx-playback", async ({ params, principal }) => {
      const artifact = await service.get(params.artifactId ?? "", principal.principalId);
      return onlyOffice.create(artifact);
    });
    router.register("GET", "/onlyoffice/artifacts/:artifactId/raw", async ({ params, url }) => {
      const artifactId = params.artifactId ?? "";
      const ticket = onlyOffice.verify(artifactId, url.searchParams.get("token"));
      const value = await service.content(artifactId, ticket.ownerId);
      if (value.artifact.primary.sha256 !== ticket.sha256) {
        throw new ApiProblemError(404, "ARTIFACT_FORBIDDEN", "PPTX 播放票据对应的版本已经变化", false);
      }
      return binaryResponse(value.bytes, value.artifact.primary.mimeType, value.artifact.displayName, false, "private, no-store");
    });
  }
  router.register("GET", "/artifacts/:artifactId/content", async ({ params, principal }) => {
    const value = await service.download(params.artifactId ?? "", principal.principalId);
    return binaryResponse(value.bytes, value.mimeType, value.fileName, true);
  });
  router.register("GET", "/artifacts/:artifactId/raw", async ({ params, principal }) => {
    const value = await service.content(params.artifactId ?? "", principal.principalId);
    return binaryResponse(value.bytes, value.artifact.primary.mimeType, value.artifact.displayName, false);
  });
  router.register("GET", "/artifacts/:artifactId/bundle/*path", async ({ params, principal }) => {
    const value = await service.bundleContent(params.artifactId ?? "", params.path ?? "", principal.principalId);
    return binaryResponse(value.bytes, value.ref.mimeType, params.path ?? "resource", false);
  });
  router.register("POST", "/artifacts/:artifactId/archive", ({ params, principal }) =>
    service.setState(params.artifactId ?? "", principal.principalId, "archived"));
  router.register("POST", "/artifacts/:artifactId/restore", ({ params, principal }) =>
    service.setState(params.artifactId ?? "", principal.principalId, "active"));
}

function binaryResponse(bytes: Buffer, mimeType: string, name: string, attachment: boolean, cacheControl?: string): Response {
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": mimeType,
      "content-length": String(bytes.byteLength),
      "content-disposition": `${attachment ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-content-type-options": "nosniff",
      "cache-control": cacheControl ?? (attachment ? "private, no-store" : "private, max-age=31536000, immutable"),
    },
  });
}
