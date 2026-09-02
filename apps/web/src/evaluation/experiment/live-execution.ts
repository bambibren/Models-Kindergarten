import type { LiveExecutionEvent, TerminalTurnState } from "@kindergarten/contracts";
import type { DemoExecution } from "../demo/agent-evaluation/types.js";

interface LiveAttempt {
  id: string;
  roundIndex: number;
  attemptIndex: number;
  maxAttempts: number;
  startedAt: number;
  completedAt?: number;
  status: "running" | "completed" | "failed";
  error?: { code: string; message: string; retryable: boolean };
  retryDelayMs?: number;
}

interface LiveTool {
  id: string;
  roundIndex: number;
  name: string;
  title: string;
  startedAt: number;
  completedAt?: number;
  status: "running" | "completed" | "failed";
  outcome?: "success" | "error" | "denied" | "duplicate_blocked";
  error?: { code: string; message: string };
}

/** 单个实验 Test 的浏览器临时投影；不写 Session，也不取代终态 Evaluation Trace。 */
export interface LiveExecutionState {
  turnId: string;
  startedAt: number;
  completedAt?: number;
  terminalStatus?: TerminalTurnState["status"];
  lastSequence: number;
  rounds: Record<string, number>;
  attempts: Record<string, LiveAttempt>;
  tools: Record<string, LiveTool>;
}

export function startLiveExecution(turnId: string, startedAt = Date.now()): LiveExecutionState {
  return { turnId, startedAt, lastSequence: -1, rounds: {}, attempts: {}, tools: {} };
}

/** 收到权威 Turn 终态后立即冻结浏览器临时计时；随后再由 Evaluation Trace 替换临时投影。 */
export function finishLiveExecution(
  state: LiveExecutionState,
  turn: TerminalTurnState,
  completedAt = Date.now(),
): LiveExecutionState {
  if (turn.turnId !== state.turnId || state.completedAt !== undefined) return state;
  return { ...state, completedAt, terminalStatus: turn.status };
}

/** 按 Turn 和 sequence 接受事件，重复或晚到事件不会覆盖更新状态。 */
export function reduceLiveExecution(state: LiveExecutionState, event: LiveExecutionEvent): LiveExecutionState {
  if (state.completedAt !== undefined || event.turnId !== state.turnId || event.sequence <= state.lastSequence) return state;
  const next: LiveExecutionState = {
    ...state,
    lastSequence: event.sequence,
    rounds: { ...state.rounds },
    attempts: { ...state.attempts },
    tools: { ...state.tools },
  };
  if (event.type === "model_round_started") {
    next.rounds[String(event.roundIndex)] = event.startedAt;
    return next;
  }
  if (event.type === "model_attempt_started") {
    next.rounds[String(event.roundIndex)] ??= event.startedAt;
    next.attempts[event.attemptId] = {
      id: event.attemptId,
      roundIndex: event.roundIndex,
      attemptIndex: event.attemptIndex,
      maxAttempts: event.maxAttempts,
      startedAt: event.startedAt,
      status: "running",
    };
    return next;
  }
  if (event.type === "model_attempt_failed" || event.type === "model_attempt_completed") {
    const previous = next.attempts[event.attemptId];
    next.rounds[String(event.roundIndex)] ??= previous?.startedAt ?? event.completedAt;
    next.attempts[event.attemptId] = {
      id: event.attemptId,
      roundIndex: event.roundIndex,
      attemptIndex: event.attemptIndex,
      maxAttempts: previous?.maxAttempts ?? event.attemptIndex + 1,
      startedAt: previous?.startedAt ?? event.completedAt,
      completedAt: event.completedAt,
      status: event.type === "model_attempt_failed" ? "failed" : "completed",
      ...(event.type === "model_attempt_failed" ? {
        error: event.error,
        ...(event.retryDelayMs === undefined ? {} : { retryDelayMs: event.retryDelayMs }),
      } : {}),
    };
    return next;
  }
  if (event.type === "tool_call_started") {
    next.tools[event.toolCallId] = {
      id: event.toolCallId,
      roundIndex: event.roundIndex,
      name: event.name,
      title: event.title,
      startedAt: event.startedAt,
      status: "running",
    };
    return next;
  }
  const previous = next.tools[event.toolCallId];
  next.tools[event.toolCallId] = {
    id: event.toolCallId,
    roundIndex: event.roundIndex,
    name: previous?.name ?? event.toolCallId,
    title: previous?.title ?? previous?.name ?? event.toolCallId,
    startedAt: previous?.startedAt ?? event.completedAt,
    completedAt: event.completedAt,
    status: event.status === "success" ? "completed" : "failed",
    outcome: event.status,
    ...(event.error ? { error: event.error } : {}),
  };
  return next;
}

/** 把实时临时投影转换为既有 ExecutionTrace 组件的数据结构。 */
export function toLiveDemoExecution(state: LiveExecutionState, now = Date.now()): DemoExecution {
  const attempts = Object.values(state.attempts);
  const tools = Object.values(state.tools);
  const observedAt = state.completedAt ?? now;
  const trace = [
    ...(attempts.length === 0 && tools.length === 0 ? [{
      at: state.startedAt,
      item: {
        id: `live-preparing:${state.turnId}`,
        round: 1,
        type: "result" as const,
        title: "正在准备 Runtime 上下文",
        detail: "正在解析冻结配置、能力快照和模型输入",
        duration: formatDuration(Math.max(0, observedAt - state.startedAt)),
        status: state.terminalStatus ? terminalNodeStatus(state.terminalStatus) : "running" as const,
      },
    }] : []),
    ...attempts.map((attempt) => ({
      at: attempt.startedAt,
      item: {
        id: `live-attempt:${attempt.id}`,
        round: attempt.roundIndex + 1,
        type: "model" as const,
        title: `模型轮次 ${attempt.roundIndex + 1}`,
        detail: attempt.error
          ? `${attempt.error.code} · ${attempt.error.message}`
          : attempt.status === "running"
            ? state.terminalStatus
              ? "Turn 已结束，正在读取最终执行记录"
              : `正在等待模型响应 · 最多 ${attempt.maxAttempts} 次重试`
            : "模型请求完成",
        duration: formatDuration(Math.max(0, (attempt.completedAt ?? observedAt) - attempt.startedAt)),
        status: attempt.status === "running" && state.terminalStatus
          ? terminalNodeStatus(state.terminalStatus)
          : attempt.status,
        attemptIndex: attempt.attemptIndex,
        ...(attempt.retryDelayMs === undefined ? {} : { retryDelay: formatDuration(attempt.retryDelayMs) }),
      },
    })),
    ...tools.map((tool) => ({
      at: tool.startedAt,
      item: {
        id: `live-tool:${tool.id}`,
        round: tool.roundIndex + 1,
        type: "tool" as const,
        title: tool.title || tool.name,
        detail: tool.error
          ? `${tool.error.code} · ${tool.error.message}`
          : tool.status === "running"
            ? state.terminalStatus ? "Turn 已结束，正在读取最终执行记录" : "工具正在执行"
            : tool.outcome === "success" ? "工具执行成功" : `工具结束 · ${tool.outcome ?? "unknown"}`,
        duration: formatDuration(Math.max(0, (tool.completedAt ?? observedAt) - tool.startedAt)),
        status: tool.status === "running" && state.terminalStatus
          ? terminalNodeStatus(state.terminalStatus)
          : tool.status,
      },
    })),
  ].toSorted((left, right) => left.at - right.at).map((entry) => entry.item);

  return {
    score: 0,
    duration: formatDuration(Math.max(0, observedAt - state.startedAt)),
    modelRounds: Object.keys(state.rounds).length,
    retryCount: attempts.filter((attempt) => attempt.attemptIndex > 0).length,
    toolCalls: tools.length,
    outputTokens: 0,
    trace,
  };
}

function terminalNodeStatus(status: TerminalTurnState["status"]): "completed" | "failed" | "cancelled" {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "cancelled";
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}
