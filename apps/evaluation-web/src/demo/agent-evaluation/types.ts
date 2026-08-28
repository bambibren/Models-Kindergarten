/** 描述「AgentId」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type AgentId = "base" | "context" | "skill";
/** 描述「AgentTone」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type AgentTone = "slate" | "blue" | "green";
/** 描述「ViewMode」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ViewMode = "answer" | "annotation";
/** 描述「AnnotationTabId」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type AnnotationTabId = "understanding" | "planning" | "output" | "execution" | "summary";
/** 描述「ScoreTabId」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ScoreTabId = "understanding" | "planning" | "output";
/** 描述「MarkColor」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type MarkColor = "blue" | "red";
/** 描述「AnswerSectionTone」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type AnswerSectionTone = "analysis" | "action" | "validation" | "risk";
/** 描述「DemoRunPolicy」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type DemoRunPolicy = "run" | "reuse_snapshot";

/** 描述「DemoAgentStreamItem」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type DemoAgentStreamItem =
  | { id: string; type: "context"; title: string; detail: string; tokens: number; raw: string }
  | { id: string; type: "thought"; title: string; text: string; tokens: number }
  | { id: string; type: "tool"; name: string; status: "completed" | "failed"; input: string; output: string; tokens: number }
  | { id: string; type: "answer"; text: string; tokens: number };

/** 描述「DemoRequirement」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoRequirement {
  id: string;
  label: string;
  sources: string[];
}

/** 描述「DemoUnderstandingPoint」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoUnderstandingPoint {
  id: string;
  text: string;
  requirementId: string;
}

/** 描述「DemoAnswerSection」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoAnswerSection {
  id: string;
  label: string;
  summary: string;
  text: string;
  tone: AnswerSectionTone;
}

/** 描述「DemoPlanStep」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoPlanStep {
  id: string;
  title: string;
  detail: string;
}

/** 描述「DemoExecution」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoExecution {
  score: number;
  duration: string;
  modelRounds: number;
  toolCalls: number;
  outputTokens: number;
}

/** 描述「DemoAgent」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoAgent {
  id: AgentId;
  name: string;
  variant: string;
  model: string;
  tone: AgentTone;
  runPolicy: DemoRunPolicy;
  stream: DemoAgentStreamItem[];
  answerSections: DemoAnswerSection[];
  understandingPoints: DemoUnderstandingPoint[];
  plan: DemoPlanStep[];
  execution: DemoExecution;
}

/** 描述「DemoSavedComparison」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoSavedComparison {
  id: string;
  title: string;
  createdAt: string;
  variantCount: number;
}

/** 描述「DemoTask」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoTask {
  title: string;
  prompt: string;
  requirements: DemoRequirement[];
}

/** 描述「TextMark」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface TextMark {
  id: string;
  agentId: AgentId;
  sectionId: string;
  start: number;
  end: number;
  color: MarkColor;
}

/** 描述「ManualScores」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ManualScores = Partial<
  Record<ScoreTabId, Partial<Record<AgentId, number>>>
>;
