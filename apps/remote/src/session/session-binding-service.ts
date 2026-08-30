import { readExperimentRunRefMeta, readSessionBindingMeta } from "@kindergarten/contracts";
import type { CreateSessionInput } from "../repository/session-repository.js";

interface NewSessionLike {
  cwd: string;
  additionalDirectories?: string[];
  mcpServers: unknown[];
  _meta?: Record<string, unknown>;
}

/** 描述「SessionBindingServiceOptions」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SessionBindingServiceOptions {
  workspaceCwd: string;
  ownerId?: string;
  agentExists(agentId: string): boolean | Promise<boolean>;
  modelStudentReady(modelStudentId: string): boolean | Promise<boolean>;
  experimentBinding(experimentId: string, variantId: string): Promise<{
    modelStudentId: string;
    agentId: string;
    experimentReasoning?: import("@kindergarten/contracts").ResolvedReasoningSnapshot;
  } | undefined>;
}

/** 只信任已保存的 Agent/Model/Experiment，不从 Prompt 或 mcpServers 推导能力。 */
export class SessionBindingService {
  /** 初始化「SessionBindingService」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly options: SessionBindingServiceOptions) {}

  /** 执行「agentExists」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
agentExists(agentId: string): boolean | Promise<boolean> {
    return this.options.agentExists(agentId);
  }

  /** 执行「resolve」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async resolve(params: NewSessionLike): Promise<CreateSessionInput> {
    if (params.cwd !== this.options.workspaceCwd) throw invalid("cwd 不在 Remote workspace policy 中");
    if ((params.additionalDirectories?.length ?? 0) > 0) throw invalid("additionalDirectories 首版必须为空");
    if (params.mcpServers.length > 0) throw invalid("mcpServers 必须为空，MCP 由 Remote Agent binding 管理");
    const runRef = readExperimentRunRefMeta(params._meta);
    const sessionMeta = readSessionBindingMeta(params._meta);
    if (runRef && sessionMeta) throw invalid("不能同时提交 chat binding 与 experiment ref");
    if (runRef) {
      const binding = await this.options.experimentBinding(runRef.experimentId, runRef.variantId);
      if (!binding) throw invalid("Experiment lane 不存在或不可运行");
      if (!await this.options.modelStudentReady(binding.modelStudentId)) throw invalid(`ModelStudent 不可用: ${binding.modelStudentId}`);
      return {
        cwd: params.cwd,
        ownerId: this.options.ownerId ?? "local-admin",
        purpose: "experiment",
        ...binding,
        experimentRef: { experimentId: runRef.experimentId, variantId: runRef.variantId },
      };
    }
    if (!sessionMeta) throw invalid("chat session/new 缺少 SessionBinding");
    const binding = sessionMeta.binding;
    await this.assertBinding(binding.modelStudentId, binding.agentId);
    return {
      cwd: params.cwd,
      ownerId: this.options.ownerId ?? "local-admin",
      purpose: "chat",
      modelStudentId: binding.modelStudentId,
      agentId: binding.agentId,
    };
  }

  /** 校验并规范化「assertBinding」输入，非法数据直接返回明确错误。 */
private async assertBinding(modelStudentId: string, agentId: string): Promise<void> {
    if (!await this.options.modelStudentReady(modelStudentId)) throw invalid(`ModelStudent 不可用: ${modelStudentId}`);
    if (!await this.agentExists(agentId)) throw invalid(`Agent 不存在: ${agentId}`);
  }
}

/** 执行「invalid」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function invalid(message: string): Error {
  return new Error(`SESSION_BINDING_INVALID: ${message}`);
}
