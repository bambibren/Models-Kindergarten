export type AgentId = "base" | "context" | "skill";
export type AgentTone = "slate" | "blue" | "green";
export type ViewMode = "answer" | "annotation";
export type AnnotationTabId = "understanding" | "planning" | "output" | "execution" | "summary";
export type ScoreTabId = "understanding" | "planning" | "output";
export type MarkColor = "blue" | "red";
export type AnswerSectionTone = "analysis" | "action" | "validation" | "risk";
export type DemoRunPolicy = "run" | "reuse_snapshot";

export type DemoAgentStreamItem =
  | { id: string; type: "context"; title: string; detail: string; tokens: number; raw: string }
  | { id: string; type: "thought"; title: string; text: string; tokens: number }
  | { id: string; type: "tool"; name: string; status: "completed" | "failed"; input: string; output: string; tokens: number }
  | { id: string; type: "answer"; text: string; tokens: number };

export interface DemoRequirement {
  id: string;
  label: string;
  sources: string[];
}

export interface DemoUnderstandingPoint {
  id: string;
  text: string;
  requirementId: string;
}

export interface DemoAnswerSection {
  id: string;
  label: string;
  summary: string;
  text: string;
  tone: AnswerSectionTone;
}

export interface DemoPlanStep {
  id: string;
  title: string;
  detail: string;
}

export interface DemoExecution {
  score: number;
  duration: string;
  modelRounds: number;
  toolCalls: number;
  outputTokens: number;
}

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

export interface DemoSavedComparison {
  id: string;
  title: string;
  createdAt: string;
  variantCount: number;
}

export interface DemoTask {
  title: string;
  prompt: string;
  requirements: DemoRequirement[];
}

export interface TextMark {
  id: string;
  agentId: AgentId;
  sectionId: string;
  start: number;
  end: number;
  color: MarkColor;
}

export type ManualScores = Partial<
  Record<ScoreTabId, Partial<Record<AgentId, number>>>
>;
