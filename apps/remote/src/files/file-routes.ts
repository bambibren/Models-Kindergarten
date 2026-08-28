import type { ControlRouter } from "../server/control-router.js";
import type { FileReferenceService } from "./file-reference-service.js";

/** 执行「registerFileRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function registerFileRoutes(router: ControlRouter, service: FileReferenceService): void {
  router.register("GET", "/files/:fileReferenceId", /** 执行「registerFileRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) =>
    service.get(params.fileReferenceId ?? "", principal.principalId));
  router.register("GET", "/files/:fileReferenceId/preview", /** 执行「registerFileRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) =>
    service.preview(params.fileReferenceId ?? "", principal.principalId));
  router.register("GET", "/files/:fileReferenceId/content", /** 执行「registerFileRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ params, principal }) => {
    const value = await service.content(params.fileReferenceId ?? "", principal.principalId);
    return new Response(new Uint8Array(value.bytes), {
      headers: {
        "content-type": value.file.mimeType,
        "content-length": String(value.file.byteLength),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(value.file.displayName)}`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  });
}
