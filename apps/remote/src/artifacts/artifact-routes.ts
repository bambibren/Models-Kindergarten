import { Readable } from "node:stream";
import type { ControlRouter } from "../server/control-router.js";
import { ApiProblemError } from "../server/api-problem.js";
import type { ArtifactService } from "./artifact-service.js";
import type { OnlyOfficePreviewService } from "./onlyoffice-preview.js";

/** 执行「registerArtifactRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function registerArtifactRoutes(router: ControlRouter, service: ArtifactService, onlyOffice?: OnlyOfficePreviewService): void {
  router.register("GET", "/artifacts", /** 执行「registerArtifactRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ url, principal }) => {
    const state = url.searchParams.get("state");
    return service.list(principal.principalId, {
      ...(url.searchParams.has("query") ? { query: url.searchParams.get("query") ?? "" } : {}),
      ...(state === "active" || state === "archived" || state === "all" ? { state } : {}),
    }).then(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(items) => ({ items }));
  });
  router.register("GET", "/artifacts/:artifactId", /** 执行「registerArtifactRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) =>
    service.get(params.artifactId ?? "", principal.principalId));
  router.register("GET", "/artifacts/:artifactId/preview", /** 执行「registerArtifactRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal, url }) =>
    service.preview(params.artifactId ?? "", principal.principalId, `${url.protocol}//${url.host}/api/control/v1`));
  if (onlyOffice) {
    router.register("GET", "/artifacts/:artifactId/pptx-playback", /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
async ({ params, principal }) => {
      const artifact = await service.get(params.artifactId ?? "", principal.principalId);
      return onlyOffice.create(artifact);
    });
    router.register("GET", "/onlyoffice/artifacts/:artifactId/raw", /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
async ({ params, url }) => {
      const artifactId = params.artifactId ?? "";
      const ticket = onlyOffice.verify(artifactId, url.searchParams.get("token"));
      const value = await service.contentStream(artifactId, ticket.ownerId);
      if (value.artifact.primary.sha256 !== ticket.sha256) {
        throw new ApiProblemError(404, "ARTIFACT_FORBIDDEN", "PPTX 播放票据对应的版本已经变化", false);
      }
      return binaryStreamResponse(value.stream, value.byteLength, value.artifact.primary.mimeType, value.artifact.displayName, false, "private, no-store");
    });
  }
  router.register("GET", "/artifacts/:artifactId/content", /** 执行「registerArtifactRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ params, principal }) => {
    const value = await service.downloadStream(params.artifactId ?? "", principal.principalId);
    return binaryStreamResponse(value.stream, value.byteLength, value.mimeType, value.fileName, true);
  });
  router.register("GET", "/artifacts/:artifactId/raw", /** 执行「registerArtifactRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ params, principal }) => {
    const value = await service.contentStream(params.artifactId ?? "", principal.principalId);
    return binaryStreamResponse(value.stream, value.byteLength, value.artifact.primary.mimeType, value.artifact.displayName, false);
  });
  router.register("GET", "/artifacts/:artifactId/bundle/*path", /** 执行「registerArtifactRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ params, principal }) => {
    const value = await service.bundleContentStream(params.artifactId ?? "", params.path ?? "", principal.principalId);
    return binaryStreamResponse(value.stream, value.ref.byteLength, value.ref.mimeType, params.path ?? "resource", false);
  });
  router.register("POST", "/artifacts/:artifactId/archive", /** 执行「registerArtifactRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) =>
    service.setState(params.artifactId ?? "", principal.principalId, "archived"));
  router.register("POST", "/artifacts/:artifactId/restore", /** 执行「registerArtifactRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) =>
    service.setState(params.artifactId ?? "", principal.principalId, "active"));
}

/** Node 文件流转换为 Web Response，Control Server 会继续用管道发送。 */
function binaryStreamResponse(
  stream: Readable,
  byteLength: number,
  mimeType: string,
  name: string,
  attachment: boolean,
  cacheControl?: string,
): Response {
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    headers: {
      "content-type": mimeType,
      "content-length": String(byteLength),
      "content-disposition": `${attachment ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-content-type-options": "nosniff",
      "cache-control": cacheControl ?? (attachment ? "private, no-store" : "private, max-age=31536000, immutable"),
    },
  });
}
