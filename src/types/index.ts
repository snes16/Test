export type AgentCompletionStatus =
  | "completed"
  | "blocked"
  | "needs_user_input"
  | "max_steps_reached"
  | "error";

export interface InteractiveElement {
  elementId: string;
  tag: string;
  role: string | null;
  name: string;
  description: string;
  visible: boolean;
  enabled: boolean;
}

export interface FormInput {
  elementId: string;
  type: string;
  name: string;
  placeholder: string;
  valuePreview: string;
  required: boolean;
  disabled: boolean;
}

export interface TextBlock {
  text: string;
  tag: string;
}

export interface PageSignals {
  loginPromptLikely: boolean;
  captchaLikely: boolean;
  paymentStepLikely: boolean;
  destructiveActionLikely: boolean;
}

export interface PageState {
  url: string;
  title: string;
  timestamp: string;
  summary: string;
  pageToken?: string;
  hasModal: boolean;
  interactiveElements: InteractiveElement[];
  formInputs: FormInput[];
  textBlocks: TextBlock[];
  signals: PageSignals;
}

export interface DomQueryMatch {
  score: number;
  source: "interactive" | "form" | "text";
  elementId?: string;
  label: string;
  details: string;
}

export interface DomQueryResult {
  question: string;
  answer: string;
  matches: DomQueryMatch[];
  signals: PageSignals;
}

export interface TaskState {
  userGoal: string;
  knownFacts: string[];
  completedActions: string[];
  unresolvedQuestions: string[];
  currentPageSummary: string;
  latestObservation: string;
  latestSignals?: PageSignals;
}

export interface TaskPolicy {
  auditReadOnlyMailboxScan: boolean;
  fullySpecified: boolean;
  requestedItemCount: number | null;
  shoppingAddToCart: boolean;
  requestedCartAddCount: number | null;
  suppressIntermediateAssistantText: boolean;
  suppressUnnecessaryUserQuestions: boolean;
}

export type MailboxScanStage =
  | "IDLE"
  | "INBOX_LISTING"
  | "OPEN_MESSAGE"
  | "EXTRACT"
  | "BACK_TO_LIST"
  | "REFRESH_LIST"
  | "NEXT_UNIQUE"
  | "COMPLETE";

export type MessageClassification = "normal" | "suspicious";

export interface VisitedMessage {
  fingerprint: string;
  previewFingerprint: string | null;
  url: string;
  sender: string;
  subject: string;
  timestampLabel: string;
  snippet: string;
  extractedText: string;
  classification: MessageClassification;
  inspectedAt: string;
}

export interface InboxCandidate {
  rowIndex: number;
  elementId: string;
  preview: string;
  previewFingerprint: string;
  senderHint: string;
  subjectHint: string;
  alreadyVisited: boolean;
}

export interface PendingMessageCandidate {
  elementId: string;
  preview: string;
  previewFingerprint: string;
  senderHint: string;
  subjectHint: string;
  rowIndex: number;
  listGeneration: number;
  listUrl: string;
  openedUrl?: string;
}

export interface MailboxScanRuntime {
  enabled: boolean;
  requestedCount: number;
  stage: MailboxScanStage;
  listGeneration: number;
  nextCandidateIndex: number;
  latestListCandidates: InboxCandidate[];
  pendingCandidate: PendingMessageCandidate | null;
  visitedMessages: Map<string, VisitedMessage>;
  visitedPreviewFingerprints: Set<string>;
  duplicateSkips: number;
  staleRecoveries: number;
}

export interface FinalReport {
  status: AgentCompletionStatus;
  summary: string;
  stepsExecuted: number;
  knownFacts: string[];
  unresolvedQuestions: string[];
}

export type ToolControlSignal =
  | {
      type: "finish";
      status: AgentCompletionStatus;
      summary: string;
      nextSteps: string[];
    }
  | {
      type: "blocked";
      reason: string;
    };

export interface ToolExecutionResult {
  ok: boolean;
  observation: unknown;
  error?: string;
  control?: ToolControlSignal;
}

export interface AgentRunResult {
  report: FinalReport;
  state: TaskState;
}

export interface AgentLogger {
  logStatus(message: string): void;
  logAssistantIntent(step: number, text: string): void;
  logToolCall(step: number, toolName: string, args: unknown): void;
  logToolResult(
    step: number,
    toolName: string,
    result: ToolExecutionResult,
    durationMs: number,
  ): void;
  logFinalReport(report: FinalReport): void;
}
