import { createHash } from "node:crypto";
import type { ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import { makeArtifactUri, PRODUCT_CONFIG } from "@kindergarten/contracts";
import type { RuntimeCapabilitySnapshot } from "../capability/capability-types.js";
import type { ModelToolCall, ModelToolDefinition } from "../model/model-provider.js";
import type { TurnScope } from "../runtime/turn-scope.js";
import {
  canonicalJson,
  modelEnvelope,
  type PermissionMode,
  type PreparedToolCall,
  type ToolExecutionContext,
  type ToolRegistryPort,
  type ToolResult,
} from "../tools/tool-registry.js";
import type { ArtifactService } from "./artifact-service.js";

export const ARTIFACT_TOOL_IDS = [
  "read_artifact",
  "publish_artifact",
  "publish_artifact_version",
  "rollback_artifact",
] as const;
type ArtifactToolName = typeof ARTIFACT_TOOL_IDS[number];

const PUBLISH_PROPERTIES = {
  artifact_type: { type: "string", enum: ["file", "html_bundle"], description: "产物类型：普通文件或 HTML Bundle" },
  artifact_id: { type: "string", description: "覆盖时填写现有 Artifact ID；首次发布不要填写" },
  path: { type: "string", description: "普通文件在当前 Session Workspace 内的相对路径" },
  root_path: { type: "string", description: "HTML Bundle 根目录，默认 ." },
  entry_path: { type: "string", description: "HTML Bundle 根目录内的 .html 入口" },
  display_name: { type: "string", description: "可选展示名" },
};

export const artifactToolDefinitions: ModelToolDefinition[] = [
  definition("read_artifact", "读取当前用户已经发布的 Artifact 当前内容与版本元数据；提供 target_path 时，把既有 Blob 原样复用到当前 Session Workspace，但该工作区副本不是新的发布结果，也不会产生新的预览入口。", {
    artifact_id: { type: "string", description: "用户明确选择或已知的稳定 Artifact ID" },
    target_path: { type: "string", description: "可选；当前 Session Workspace 内的相对目标路径" },
    artifact_path: { type: "string", description: "可选；HTML Bundle 内要复用的相对资源路径" },
  }, ["artifact_id"]),
  definition("publish_artifact", "显式发布当前 Session Workspace 中的文件或 HTML Bundle。未提供 artifact_id 时创建 v1；提供 artifact_id 时覆盖该 Artifact 的当前内容，保持相同 ID 和 vN。只有成功发布的 Artifact 才能交付、预览、下载、Mention 和后续复用；用户要求生成文件时，成功发布前不得结束任务。", PUBLISH_PROPERTIES, ["artifact_type"]),
  definition("publish_artifact_version", "把现有 Artifact 发布为一个新的可见 vN，服务端自动递增版本号并返回新的 Artifact ID。模型不得自行填写或猜测版本号。适用于跨会话修改、修改 Mention 的旧 Artifact，或用户明确要求保留旧版、创建新版本。", {
    ...PUBLISH_PROPERTIES,
    artifact_id: { type: "string", description: "作为版本来源的现有 Artifact ID" },
  }, ["artifact_type", "artifact_id"]),
  definition("rollback_artifact", `仅当用户明确要求回滚时，把指定 Artifact ID 恢复到其最近隐藏修订之一。回滚不会暴露历史快照 ID；最多可回退 ${PRODUCT_CONFIG.artifact.maxRetainedRevisions - 1} 步。`, {
    artifact_id: { type: "string", description: "要回滚的现有 Artifact ID" },
    steps: { type: "integer", minimum: 1, maximum: PRODUCT_CONFIG.artifact.maxRetainedRevisions - 1, description: "向前回退的修订步数" },
  }, ["artifact_id", "steps"]),
];

/** 描述「ArtifactToolProvider」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class ArtifactToolProvider implements ToolRegistryPort {
  readonly providerId = "artifact";
  readonly definitions: ModelToolDefinition[];

  /** 初始化「ArtifactToolProvider」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly service: ArtifactService,
    private readonly scope: TurnScope,
    private readonly bindings: Map<string, { enabled: boolean; permission: "allow" | "ask" | "deny" }>,
  ) {
    this.definitions = artifactToolDefinitions.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => this.bindings.get(item.function.name)?.enabled === true);
  }

  /** 执行「prepare」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
prepare(call: ModelToolCall, fallbackId: string): PreparedToolCall {
    const name = toolName(call.name);
    if (!this.definitions.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.function.name === name)) throw new Error(`当前 Agent 未启用 Artifact Tool: ${name}`);
    const id = call.id ?? fallbackId;
    const permission = this.permission(name);
    if (name === "read_artifact") {
      const artifactId = stringArg(call.arguments, "artifact_id");
      const targetPath = optionalStringArg(call.arguments, "target_path");
      const artifactPath = optionalStringArg(call.arguments, "artifact_path");
      return prepared(id, name, targetPath ? `复用 Artifact 到 ${targetPath}` : "读取 Artifact", targetPath ? "edit" : "read", {
        artifact_id: artifactId,
        ...(targetPath ? { target_path: targetPath } : {}),
        ...(artifactPath ? { artifact_path: artifactPath } : {}),
      }, permission, []);
    }
    if (name === "rollback_artifact") {
      const artifactId = stringArg(call.arguments, "artifact_id");
      const steps = integerArg(call.arguments, "steps", 1, PRODUCT_CONFIG.artifact.maxRetainedRevisions - 1);
      return prepared(id, name, `回滚 Artifact ${artifactId}`, "other", {
        artifact_id: artifactId,
        steps,
      }, permission, []);
    }
    const artifactType = artifactTypeArg(call.arguments);
    const artifactId = optionalStringArg(call.arguments, "artifact_id");
    if (name === "publish_artifact_version" && !artifactId) throw new Error("artifact_id 必须是非空字符串");
    const displayName = optionalStringArg(call.arguments, "display_name");
    const source = artifactType === "file"
      ? { path: stringArg(call.arguments, "path") }
      : {
          root_path: optionalStringArg(call.arguments, "root_path") ?? ".",
          entry_path: stringArg(call.arguments, "entry_path"),
        };
    const action = name === "publish_artifact_version" ? "发布新版本" : artifactId ? "覆盖发布" : "发布";
    const sourceLabel = artifactType === "file" ? source.path : source.entry_path;
    return prepared(id, name, `${action} ${sourceLabel}`, "other", {
      artifact_type: artifactType,
      ...(artifactId ? { artifact_id: artifactId } : {}),
      ...source,
      ...(displayName ? { display_name: displayName } : {}),
    }, permission, []);
  }

  /** 执行「execute」主流程，传播取消与失败并在结束时清理临时资源。 */
async execute(call: PreparedToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (context.signal.aborted) throw new DOMException("已取消", "AbortError");
    if (call.name === "read_artifact") {
      const artifactId = String(call.arguments.artifact_id);
      const targetPath = optionalStringArg(call.arguments, "target_path");
      if (targetPath) {
        const value = await this.service.materialize(
          artifactId,
          this.scope.ownerId,
          this.scope.sessionId,
          targetPath,
          optionalStringArg(call.arguments, "artifact_path"),
        );
        return result(call, {
          artifactId: value.artifact.artifactId,
          uri: makeArtifactUri(value.artifact.artifactId),
          targetPath,
          bytes: value.bytes,
          reusedBlob: true,
          seriesId: value.artifact.seriesId ?? value.artifact.artifactId,
          version: value.artifact.version ?? 1,
          rollbackAvailable: rollbackAvailable(value.artifact.revisions?.length ?? 1),
        }, [], [], undefined,
        "The existing Artifact was copied into the Session Workspace. This workspace copy is not a newly published Artifact and has no new preview or delivery link.");
      }
      const artifact = await this.service.get(artifactId, this.scope.ownerId);
      return result(call, {
        artifactId: artifact.artifactId,
        uri: makeArtifactUri(artifact.artifactId),
        displayName: artifact.displayName,
        kind: artifact.kind,
        mimeType: artifact.primary.mimeType,
        byteLength: artifact.primary.byteLength,
        state: artifact.state,
        seriesId: artifact.seriesId ?? artifact.artifactId,
        version: artifact.version ?? 1,
        rollbackAvailable: rollbackAvailable(artifact.revisions?.length ?? 1),
        ...(artifact.manifest ? { files: Object.keys(artifact.manifest.files), entryPath: artifact.manifest.entryPath } : {}),
      });
    }
    if (call.name === "rollback_artifact") {
      const artifact = await this.service.rollback({
        artifactId: String(call.arguments.artifact_id),
        ownerId: this.scope.ownerId,
        sessionId: this.scope.sessionId,
        turnId: this.scope.turnId,
        operationId: this.operationId(call),
        steps: Number(call.arguments.steps),
      });
      return this.publicationResult(call, artifact, "rolled_back");
    }
    const artifactType = artifactTypeArg(call.arguments);
    const artifactId = optionalStringArg(call.arguments, "artifact_id");
    const common = {
          ownerId: this.scope.ownerId,
          sessionId: this.scope.sessionId,
          turnId: this.scope.turnId,
          operationId: this.operationId(call),
          ...(call.arguments.display_name ? { displayName: String(call.arguments.display_name) } : {}),
    };
    const artifact = artifactType === "file"
      ? call.name === "publish_artifact_version"
        ? await this.service.publishFileVersion(requiredArtifactId(artifactId), { ...common, path: String(call.arguments.path) })
        : artifactId
          ? await this.service.replaceFile(artifactId, { ...common, path: String(call.arguments.path) })
          : await this.service.publishFile({ ...common, path: String(call.arguments.path) })
      : call.name === "publish_artifact_version"
        ? await this.service.publishHtmlBundleVersion(requiredArtifactId(artifactId), {
            ...common,
            rootPath: String(call.arguments.root_path),
            entryPath: String(call.arguments.entry_path),
          })
        : artifactId
          ? await this.service.replaceHtmlBundle(artifactId, {
              ...common,
              rootPath: String(call.arguments.root_path),
              entryPath: String(call.arguments.entry_path),
            })
          : await this.service.publishHtmlBundle({
              ...common,
              rootPath: String(call.arguments.root_path),
              entryPath: String(call.arguments.entry_path),
            });
    const publication = call.name === "publish_artifact_version" ? "versioned" : artifactId ? "replaced" : "created";
    return this.publicationResult(call, artifact, publication);
  }

  /** 执行「publicationResult」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private publicationResult(
    call: PreparedToolCall,
    artifact: Awaited<ReturnType<ArtifactService["get"]>>,
    publication: "created" | "replaced" | "versioned" | "rolled_back",
  ): ToolResult {
    const uri = makeArtifactUri(artifact.artifactId);
    const link: ToolCallContent = {
      type: "content",
      content: {
        type: "resource_link",
        uri,
        name: artifact.displayName,
        title: artifact.displayName,
        mimeType: artifact.primary.mimeType,
        size: artifact.primary.byteLength,
      },
    };
    return result(call, {
      artifactId: artifact.artifactId,
      uri,
      displayName: artifact.displayName,
      kind: artifact.kind,
      byteLength: artifact.primary.byteLength,
      seriesId: artifact.seriesId ?? artifact.artifactId,
      version: artifact.version ?? 1,
      rollbackAvailable: rollbackAvailable(artifact.revisions?.length ?? 1),
      publication,
    }, [link], [], undefined,
    "Only this successfully published Artifact is deliverable and previewable. Return its artifact URI and server-assigned version to the user as the generated file result.");
  }

  /** 生成「capabilitySnapshot」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
capabilitySnapshot(): RuntimeCapabilitySnapshot {
    return {
      tools: this.definitions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(definition) => ({
        id: `artifact:tool:${definition.function.name}`,
        modelName: definition.function.name,
        origin: "builtin",
        schemaHash: createHash("sha256").update(canonicalJson(definition)).digest("hex"),
      })),
      mcpServers: [],
      skills: [],
    };
  }

  /** 执行「permission」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private permission(name: ArtifactToolName): PermissionMode {
    return this.bindings.get(name)?.permission ?? "deny";
  }

  /** 由规范字段生成稳定的「operationId」标识，供索引精确定位且不保留原始大对象。 */
private operationId(call: PreparedToolCall): string {
    const promptOperation = this.scope.operationId ?? this.scope.turnId;
    return createHash("sha256").update(`${promptOperation}\0${call.name}\0${canonicalJson(call.arguments)}`).digest("hex");
  }
}

/** 执行「prepared」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function prepared(
  id: string,
  name: ArtifactToolName,
  title: string,
  kind: ToolKind,
  args: Record<string, unknown>,
  permission: PermissionMode,
  locations: ToolCallLocation[],
): PreparedToolCall {
  return { id, name, title, kind, arguments: args, permission, locations, dedupeKey: `${name}:${canonicalJson(args)}`, retry: "none" };
}

/** 执行「result」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function result(
  call: PreparedToolCall,
  rawOutput: unknown,
  content: ToolCallContent[] = [],
  locations: ToolCallLocation[] = call.locations,
  effects?: ToolResult["effects"],
  instructionOverride?: string,
): ToolResult {
  return {
    modelContent: modelEnvelope(call, true, rawOutput, undefined, instructionOverride),
    rawOutput,
    content: content.length > 0 ? content : [{ type: "content", content: { type: "text", text: JSON.stringify(rawOutput, null, 2) } }],
    locations,
    ...(effects ? { effects } : {}),
  };
}

/** 执行「definition」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function definition(name: ArtifactToolName, description: string, properties: Record<string, unknown>, required?: string[]): ModelToolDefinition {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, ...(required ? { required } : {}), additionalProperties: false } } };
}

/** 根据已校验输入构建「toolName」结果，不额外持有调用方的大对象。 */
function toolName(value: string): ArtifactToolName {
  if (ARTIFACT_TOOL_IDS.includes(value as ArtifactToolName)) return value as ArtifactToolName;
  throw new Error(`未知 Artifact Tool: ${value}`);
}

/** 执行「stringArg」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function stringArg(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} 必须是非空字符串`);
  return value;
}

/** 执行「optionalStringArg」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function optionalStringArg(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  return stringArg(input, name);
}

/** 执行「artifactTypeArg」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function artifactTypeArg(input: Record<string, unknown>): "file" | "html_bundle" {
  const value = input.artifact_type;
  if (value === "file" || value === "html_bundle") return value;
  throw new Error("artifact_type 必须是 file 或 html_bundle");
}

/** 执行「integerArg」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function integerArg(input: Record<string, unknown>, name: string, minimum: number, maximum: number): number {
  const value = input[name];
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 的整数`);
  }
  return Number(value);
}

/** 校验并取得「requiredArtifactId」所需对象；缺失或归属不符时立即抛出明确错误。 */
function requiredArtifactId(value: string | undefined): string {
  if (!value) throw new Error("artifact_id 必须是非空字符串");
  return value;
}

/** 执行「rollbackAvailable」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function rollbackAvailable(revisionCount: number): number {
  return Math.max(0, Math.min(
    PRODUCT_CONFIG.artifact.maxRetainedRevisions - 1,
    revisionCount - 1,
  ));
}
