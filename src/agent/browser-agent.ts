import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./system-prompt";
import { hasBlockingSignals } from "./task-policy";
import { RuntimeStats, ToolRegistry } from "../tools/tool-registry";
import {
  AgentCompletionStatus,
  AgentLogger,
  AgentRunResult,
  FinalReport,
  TaskPolicy,
  TaskState,
  ToolExecutionResult,
} from "../types";

interface BrowserAgentOptions {
  client: OpenAI;
  model: string;
  toolRegistry: ToolRegistry;
  runtimeStats: RuntimeStats;
  logger: AgentLogger;
  taskPolicy: TaskPolicy;
  maxSteps?: number;
}

interface FunctionCall {
  name: string;
  callId: string;
  arguments: string;
}

interface ParsedCall {
  call: FunctionCall;
  redirected: boolean;
  reason?: string;
}

interface ExecutedCallOutcome {
  result: ToolExecutionResult;
  executedToolName: string;
}

const DEFAULT_CONTEXT_RESET_EVERY_STEPS = 30;
const DEFAULT_MODEL_TOOL_OUTPUT_MAX_CHARS = 6000;
const MODEL_COMPACT_STRING_LIMIT = 260;
const MODEL_COMPACT_ARRAY_LIMIT = 8;
const MODEL_COMPACT_OBJECT_KEY_LIMIT = 24;
const MODEL_COMPACT_MAX_DEPTH = 4;

function parsePositiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function compactForModel(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return value.length > MODEL_COMPACT_STRING_LIMIT
      ? `${value.slice(0, MODEL_COMPACT_STRING_LIMIT - 3)}...`
      : value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (depth >= MODEL_COMPACT_MAX_DEPTH) {
    return stringifyShort(value, MODEL_COMPACT_STRING_LIMIT);
  }

  if (Array.isArray(value)) {
    return value.slice(0, MODEL_COMPACT_ARRAY_LIMIT).map((item) => compactForModel(item, depth + 1));
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      MODEL_COMPACT_OBJECT_KEY_LIMIT,
    );
    const compacted: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      compacted[key] = compactForModel(item, depth + 1);
    }
    return compacted;
  }

  return stringifyShort(value, MODEL_COMPACT_STRING_LIMIT);
}

function summarizeActionStats(actions: string[]): string {
  if (actions.length === 0) {
    return "none";
  }

  const counts = new Map<string, number>();
  for (const action of actions) {
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([name, count]) => `${name}:${count}`)
    .join(", ");
}

function stringifyShort(value: unknown, max = 280): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (raw.length <= max) {
    return raw;
  }
  return `${raw.slice(0, max - 3)}...`;
}

function normalizeUrlCandidate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed).toString();
  } catch {
    return null;
  }
}

function extractAssistantIntent(response: any): string {
  const chunks: string[] = [];

  if (typeof response?.output_text === "string" && response.output_text.trim().length > 0) {
    chunks.push(response.output_text.trim());
  }

  for (const item of response?.output ?? []) {
    if (item?.type !== "message") {
      continue;
    }
    for (const part of item?.content ?? []) {
      if (typeof part?.text === "string") {
        chunks.push(part.text.trim());
      } else if (typeof part?.output_text === "string") {
        chunks.push(part.output_text.trim());
      }
    }
  }

  return chunks.filter(Boolean).join("\n").trim();
}

function extractFunctionCalls(response: any): FunctionCall[] {
  const calls: FunctionCall[] = [];

  for (const item of response?.output ?? []) {
    if (item?.type !== "function_call") {
      continue;
    }
    if (!item?.name || !item?.call_id) {
      continue;
    }
    calls.push({
      name: item.name,
      callId: item.call_id,
      arguments: typeof item.arguments === "string" ? item.arguments : "{}",
    });
  }

  return calls;
}

function createInitialState(goal: string): TaskState {
  return {
    userGoal: goal,
    knownFacts: [],
    completedActions: [],
    unresolvedQuestions: [],
    currentPageSummary: "No page observed yet.",
    latestObservation: "Session started.",
    currentUrl: undefined,
    currentTitle: undefined,
  };
}

function pushKnownFact(state: TaskState, fact: string): void {
  if (!state.knownFacts.includes(fact)) {
    state.knownFacts.push(fact);
  }
}

function applyObservedPageSnapshot(
  state: TaskState,
  snapshot: {
    summary?: unknown;
    url?: unknown;
    title?: unknown;
    signals?: unknown;
  },
): void {
  const summary = typeof snapshot.summary === "string" ? snapshot.summary : "";
  const title = typeof snapshot.title === "string" ? snapshot.title : "";
  const urlRaw = typeof snapshot.url === "string" ? snapshot.url : "";
  const url = urlRaw ? normalizeUrlCandidate(urlRaw) : null;

  if (summary) {
    state.currentPageSummary = summary;
  }
  if (title) {
    state.currentTitle = title;
  }
  if (url) {
    state.currentUrl = url;
  }

  const maybeSignals = snapshot.signals as TaskState["latestSignals"] | undefined;
  if (maybeSignals) {
    state.latestSignals = maybeSignals;
  }

  if (url && title) {
    pushKnownFact(state, `Observed page: ${title} (${url})`);
  }
}

function updateStateFromToolResult(
  state: TaskState,
  toolName: string,
  result: ToolExecutionResult,
): void {
  state.completedActions.push(toolName);
  state.latestObservation = stringifyShort(result.observation, 600);

  const observation =
    result.observation && typeof result.observation === "object"
      ? (result.observation as Record<string, unknown>)
      : null;

  if (result.ok && observation) {
    applyObservedPageSnapshot(state, {
      summary: observation.summary,
      url: observation.url,
      title: observation.title,
      signals: observation.signals,
    });

    // click_element / recovery flows often expose state under postClickState.
    if (observation.postClickState && typeof observation.postClickState === "object") {
      const postClickState = observation.postClickState as Record<string, unknown>;
      applyObservedPageSnapshot(state, {
        summary: postClickState.summary,
        url: postClickState.url,
        title: postClickState.title,
        signals: postClickState.signals,
      });
    }

    if (typeof observation.currentUrl === "string") {
      const normalizedCurrent = normalizeUrlCandidate(observation.currentUrl);
      if (normalizedCurrent) {
        state.currentUrl = normalizedCurrent;
      }
    }
    if (typeof observation.currentTitle === "string" && observation.currentTitle.trim()) {
      state.currentTitle = observation.currentTitle.trim();
    }

    if (typeof observation.answer === "string" && observation.answer.trim()) {
      pushKnownFact(state, `DOM query: ${observation.answer.trim()}`);
    }

    if (typeof observation.extractedText === "string") {
      const text = observation.extractedText.replace(/\s+/g, " ").trim();
      const elementId =
        typeof observation.elementId === "string" && observation.elementId.trim().length > 0
          ? observation.elementId.trim()
          : null;
      if (text.length >= 12) {
        pushKnownFact(
          state,
          `Extracted text${elementId ? ` (${elementId})` : ""}: ${stringifyShort(text, 180)}`,
        );
      }
    }
  }

  if (toolName === "request_user_input" && !result.ok) {
    const question =
      (result.observation as { question?: string }).question ??
      "User input requested by the model.";
    if (!state.unresolvedQuestions.includes(question)) {
      state.unresolvedQuestions.push(question);
    }
  }
}

function buildFinalReport(
  status: AgentCompletionStatus,
  summary: string,
  stepsExecuted: number,
  state: TaskState,
): FinalReport {
  return {
    status,
    summary,
    stepsExecuted,
    knownFacts: state.knownFacts.slice(0, 25),
    unresolvedQuestions: state.unresolvedQuestions.slice(0, 25),
  };
}

export class BrowserAgent {
  private readonly maxSteps: number;
  private readonly contextResetEverySteps: number;
  private readonly modelToolOutputMaxChars: number;

  constructor(private readonly options: BrowserAgentOptions) {
    this.maxSteps = options.maxSteps ?? 50;
    this.contextResetEverySteps = parsePositiveIntFromEnv(
      "AGENT_CONTEXT_RESET_EVERY_STEPS",
      DEFAULT_CONTEXT_RESET_EVERY_STEPS,
    );
    this.modelToolOutputMaxChars = parsePositiveIntFromEnv(
      "AGENT_MODEL_TOOL_OUTPUT_MAX_CHARS",
      DEFAULT_MODEL_TOOL_OUTPUT_MAX_CHARS,
    );
  }

  private shouldResetContext(step: number): boolean {
    if (this.options.taskPolicy.jobApplicationFlow && !this.isJobApplicationComplete()) {
      return false;
    }
    return this.contextResetEverySteps > 0 && step % this.contextResetEverySteps === 0;
  }

  private buildContextResetPrompt(goal: string, state: TaskState, step: number): string {
    const recentActions = state.completedActions.slice(-12).join(", ") || "none";
    const knownFacts =
      state.knownFacts.length > 0 ? state.knownFacts.slice(-6).join(" | ") : "none";
    const unresolved =
      state.unresolvedQuestions.length > 0
        ? state.unresolvedQuestions.slice(-4).join(" | ")
        : "none";
    const mailbox = this.options.runtimeStats.mailboxScan;
    const mailboxLine = mailbox.enabled
      ? `${mailbox.stage} ${mailbox.visitedMessages.size}/${Math.max(1, mailbox.requestedCount)} unique`
      : "disabled";
    const cartTarget = this.options.taskPolicy.requestedCartAddCount;
    const cartLine =
      cartTarget !== null
        ? `${this.options.runtimeStats.cartAddActions}/${cartTarget}`
        : "disabled";
    const job = this.options.runtimeStats.jobApplication;
    const jobLine = job.enabled
      ? `opened=${job.openedVacancyFingerprints.size}, read=${job.extractedVacancyFingerprints.size}, cover=${job.coverLetterVacancyFingerprints.size}, applied=${job.appliedVacancyFingerprints.size}/${Math.max(1, job.targetApplyCount)}`
      : "disabled";

    return (
      `Continue the same task in a fresh context window.\n` +
      `User goal: ${goal}\n` +
      `Progress snapshot at step ${step}:\n` +
      `- Current page summary: ${stringifyShort(state.currentPageSummary, 260)}\n` +
      `- Latest observation: ${stringifyShort(state.latestObservation, 260)}\n` +
      `- Recent actions: ${recentActions}\n` +
      `- Action frequencies: ${summarizeActionStats(state.completedActions)}\n` +
      `- Known facts: ${stringifyShort(knownFacts, 360)}\n` +
      `- Unresolved questions: ${stringifyShort(unresolved, 280)}\n` +
      `- Mailbox progress: ${mailboxLine}\n` +
      `- Cart add progress: ${cartLine}\n` +
      `- Job application progress: ${jobLine}\n` +
      `Rules:\n` +
      `- Continue autonomously.\n` +
      `- Call exactly one next tool or finish_task.\n` +
      `- Do not repeat already completed work.\n`
    );
  }

  private serializeToolResultForModel(result: ToolExecutionResult): string {
    const compactPayload = {
      ok: result.ok,
      observation: compactForModel(result.observation),
      error: result.error ?? null,
      control: result.control ?? null,
    };

    const serialized = JSON.stringify(compactPayload);
    if (serialized.length <= this.modelToolOutputMaxChars) {
      return serialized;
    }

    return JSON.stringify({
      ok: result.ok,
      observation: stringifyShort(compactPayload.observation, 480),
      error: result.error ?? null,
      control: result.control ?? null,
      truncated: true,
    });
  }

  private parseToolArgs(raw: string): Record<string, unknown> {
    try {
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private stringifyToolArgs(args: Record<string, unknown>): string {
    return JSON.stringify(args);
  }

  private hasProfileResumeEvidence(state: TaskState): boolean {
    const haystack = [
      state.currentPageSummary,
      state.latestObservation,
      state.knownFacts.slice(-12).join(" "),
    ]
      .join(" ")
      .toLowerCase();

    return /(resume|cv|profile|резюм|профил|hh\.ru\/profile\/me|hh\.ru\/applicant\/resumes)/i.test(
      haystack,
    );
  }

  private currentUrlFromState(state: TaskState): string | null {
    const direct = state.currentUrl ? normalizeUrlCandidate(state.currentUrl) : null;
    if (direct) {
      return direct;
    }

    const fromSummary = state.currentPageSummary.match(/\bat\s+(https?:\/\/\S+?)(?:\.|$)/i)?.[1];
    const normalizedSummary = fromSummary ? normalizeUrlCandidate(fromSummary) : null;
    if (normalizedSummary) {
      return normalizedSummary;
    }

    const fromLatestObservation = state.latestObservation.match(/https?:\/\/[^\s)"'<>]+/i)?.[0];
    const normalizedLatest = fromLatestObservation
      ? normalizeUrlCandidate(fromLatestObservation)
      : null;
    if (normalizedLatest) {
      return normalizedLatest;
    }

    for (let index = state.knownFacts.length - 1; index >= 0; index -= 1) {
      const fact = state.knownFacts[index];
      const match = fact.match(/\((https?:\/\/[^)\s]+)\)/i)?.[1];
      const normalized = match ? normalizeUrlCandidate(match) : null;
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  private buildJobSearchUrl(): string {
    const hint = (this.options.taskPolicy.jobSearchQueryHint ?? "").trim();
    if (!hint) {
      return "https://hh.ru/search/vacancy";
    }
    return `https://hh.ru/search/vacancy?text=${encodeURIComponent(hint)}`;
  }

  private isHhProfileLikeUrl(url: string): boolean {
    const normalized = url.toLowerCase();
    return (
      /https?:\/\/(?:www\.)?hh\.ru\/applicant\/resumes(?:\/|\?|$)/i.test(normalized) ||
      /https?:\/\/(?:www\.)?hh\.ru\/profile\/me(?:\/|\?|$)/i.test(normalized) ||
      /https?:\/\/(?:www\.)?hh\.ru\/applicant(?:\/|\?|$)/i.test(normalized)
    );
  }

  private isHhVacancySearchUrl(url: string): boolean {
    return /https?:\/\/(?:www\.)?hh\.ru\/search\/vacancy(?:\/|\?|$)/i.test(url);
  }

  private isHhVacancyDetailUrl(url: string): boolean {
    return /https?:\/\/(?:www\.)?hh\.ru\/vacancy\/\d+(?:\/|\?|$)/i.test(url);
  }

  private isHhVacancyResponseUrl(url: string): boolean {
    return /https?:\/\/(?:www\.)?hh\.ru\/applicant\/vacancy_response(?:\/|\?|$)/i.test(url);
  }

  private hasVisitedVacancySearch(state: TaskState): boolean {
    const current = this.currentUrlFromState(state) ?? "";
    if (this.isHhVacancySearchUrl(current)) {
      return true;
    }
    return state.knownFacts.some((fact) => /https?:\/\/(?:www\.)?hh\.ru\/search\/vacancy/i.test(fact));
  }

  private nextMailboxCandidateElementId(): string | null {
    const scan = this.options.runtimeStats.mailboxScan;
    if (!scan.enabled || scan.latestListCandidates.length === 0) {
      return null;
    }

    let index = Math.max(0, scan.nextCandidateIndex);
    while (index < scan.latestListCandidates.length) {
      const candidate = scan.latestListCandidates[index];
      if (!scan.visitedPreviewFingerprints.has(candidate.previewFingerprint)) {
        scan.nextCandidateIndex = index;
        return candidate.elementId;
      }
      index += 1;
    }
    scan.nextCandidateIndex = scan.latestListCandidates.length;
    return null;
  }

  private isJobApplicationComplete(): boolean {
    const job = this.options.runtimeStats.jobApplication;
    if (!job.enabled) {
      return false;
    }
    const target = Math.max(1, job.targetApplyCount);
    return (
      job.appliedVacancyFingerprints.size >= target &&
      job.extractedVacancyFingerprints.size >= target &&
      job.coverLetterVacancyFingerprints.size >= target
    );
  }

  private steerMailboxCall(call: FunctionCall): ParsedCall {
    const rewrite = (
      name: string,
      args: Record<string, unknown>,
      reason: string,
    ): ParsedCall => ({
      call: {
        ...call,
        name,
        arguments: this.stringifyToolArgs(args),
      },
      redirected: true,
      reason,
    });

    const job = this.options.runtimeStats.jobApplication;
    if (job.enabled && this.isJobApplicationComplete() && call.name !== "finish_task") {
      return rewrite(
        "finish_task",
        {
          status: "completed",
          summary: "Job application task completed.",
          nextSteps: [],
        },
        `job application completion criteria reached (${job.appliedVacancyFingerprints.size}/${Math.max(1, job.targetApplyCount)})`,
      );
    }

    if (job.enabled && call.name === "finish_task" && !this.isJobApplicationComplete()) {
      const target = Math.max(1, job.targetApplyCount);
      if (job.extractedVacancyFingerprints.size < target) {
        return rewrite(
          "query_dom",
          {
            question:
              "Find the vacancy search results list and identify the next relevant vacancy row/link to open.",
            maxResults: 8,
          },
          `finish_task blocked: vacancies read ${job.extractedVacancyFingerprints.size}/${target}`,
        );
      }
      if (job.coverLetterVacancyFingerprints.size < target) {
        return rewrite(
          "query_dom",
          {
            question:
              "Locate the cover-letter field on the current vacancy response form and provide its elementId.",
            maxResults: 8,
          },
          `finish_task blocked: cover letters ${job.coverLetterVacancyFingerprints.size}/${target}`,
        );
      }
      if (job.appliedVacancyFingerprints.size < target) {
        return rewrite(
          "query_dom",
          {
            question:
              "Locate the apply/respond button for the current vacancy and provide its elementId.",
            maxResults: 8,
          },
          `finish_task blocked: applied ${job.appliedVacancyFingerprints.size}/${target}`,
        );
      }
    }

    const requiredCartAdds = this.options.taskPolicy.requestedCartAddCount;
    if (
      requiredCartAdds !== null &&
      this.options.runtimeStats.cartAddActions >= requiredCartAdds &&
      call.name !== "finish_task"
    ) {
      return rewrite(
        "finish_task",
        {
          status: "completed",
          summary: "Cart task completed.",
          nextSteps: [],
        },
        `required cart additions already reached (${this.options.runtimeStats.cartAddActions}/${requiredCartAdds})`,
      );
    }

    const scan = this.options.runtimeStats.mailboxScan;
    if (!scan.enabled) {
      return { call, redirected: false };
    }

    const required = Math.max(1, scan.requestedCount || 10);
    const uniqueOpened = scan.visitedMessages.size;
    const nextElementId = this.nextMailboxCandidateElementId();

    if (uniqueOpened >= required) {
      if (call.name === "finish_task") {
        return { call, redirected: false };
      }
      return rewrite(
        "finish_task",
        {
          status: "completed",
          summary: "Mailbox scan completed.",
          nextSteps: [],
        },
        `required unique messages already reached (${uniqueOpened}/${required})`,
      );
    }

    if (call.name === "finish_task" && uniqueOpened < required) {
      if (scan.stage === "OPEN_MESSAGE" || scan.stage === "EXTRACT") {
        return rewrite(
          "extract_text",
          { maxLength: 1500 },
          `finish_task blocked: message is open and unique ${uniqueOpened}/${required}`,
        );
      }
      if (scan.stage === "BACK_TO_LIST") {
        return rewrite(
          "go_back",
          {},
          `finish_task blocked: need to return to inbox list (${uniqueOpened}/${required})`,
        );
      }
      if (nextElementId) {
        return rewrite(
          "click_element",
          { elementId: nextElementId, button: "left", doubleClick: false },
          `finish_task blocked: need more unique messages (${uniqueOpened}/${required})`,
        );
      }
      return rewrite(
        "get_page_state",
        { note: "Refresh inbox candidates for mailbox scan." },
        "finish_task blocked: no candidate cached",
      );
    }

    if (scan.stage === "OPEN_MESSAGE" || scan.stage === "EXTRACT") {
      if (call.name !== "extract_text") {
        return rewrite(
          "extract_text",
          { maxLength: 1500 },
          `stage=${scan.stage} requires extraction from opened message`,
        );
      }
      return { call, redirected: false };
    }

    if (scan.stage === "BACK_TO_LIST") {
      if (call.name !== "go_back") {
        return rewrite(
          "go_back",
          {},
          "stage=BACK_TO_LIST requires return to inbox",
        );
      }
      return { call, redirected: false };
    }

    if (scan.stage === "INBOX_LISTING" || scan.stage === "REFRESH_LIST" || scan.stage === "NEXT_UNIQUE") {
      if (call.name === "extract_text") {
        if (nextElementId) {
          return rewrite(
            "click_element",
            { elementId: nextElementId, button: "left", doubleClick: false },
            `stage=${scan.stage} requires opening next unique message`,
          );
        }
        return rewrite(
          "get_page_state",
          { note: "Refresh inbox and locate next unique row." },
          `stage=${scan.stage} needs fresh candidates`,
        );
      }

      if (call.name === "click_element") {
        if (!nextElementId) {
          return rewrite(
            "get_page_state",
            { note: "Refresh inbox and locate next unique row." },
            "no next candidate available for click_element",
          );
        }

        const parsed = this.parseToolArgs(call.arguments);
        const requestedElementId =
          typeof parsed.elementId === "string" ? parsed.elementId : "";
        if (requestedElementId !== nextElementId) {
          return rewrite(
            "click_element",
            { elementId: nextElementId, button: "left", doubleClick: false },
            `redirected click from ${requestedElementId || "unknown"} to next unique ${nextElementId}`,
          );
        }
      }
    }

    return { call, redirected: false };
  }

  private async executeCallWithPolicy(
    call: FunctionCall,
    state: TaskState,
    step: number,
  ): Promise<ExecutedCallOutcome> {
    const mailboxSteered = this.steerMailboxCall(call);
    let effectiveCall = mailboxSteered.call;

    if (mailboxSteered.redirected) {
      this.options.logger.logStatus(
        `Step ${step}: mailbox policy redirected ${call.name} -> ${effectiveCall.name}. ${mailboxSteered.reason ?? ""}`.trim(),
      );
    }

    if (this.options.taskPolicy.jobApplicationFlow) {
      const args = this.parseToolArgs(effectiveCall.arguments);
      const currentUrl = this.currentUrlFromState(state) ?? "";
      const hasProfileEvidence = this.hasProfileResumeEvidence(state);
      const visitedVacancySearch = this.hasVisitedVacancySearch(state);
      const targetUrl = typeof args.url === "string" ? args.url.trim() : "";
      const jobRuntime = this.options.runtimeStats.jobApplication;
      const targetApplyCount = Math.max(1, jobRuntime.targetApplyCount);
      const hasPendingCurrentVacancy =
        Boolean(jobRuntime.currentVacancyFingerprint) &&
        jobRuntime.appliedVacancyFingerprints.size < targetApplyCount;
      const missingCoverLetterForCurrentVacancy =
        Boolean(jobRuntime.currentVacancyFingerprint) &&
        !jobRuntime.coverLetterVacancyFingerprints.has(
          jobRuntime.currentVacancyFingerprint as string,
        );
      const coverLetterStepRequiredNow =
        this.isHhVacancyResponseUrl(currentUrl) &&
        jobRuntime.appliedVacancyFingerprints.size > 0 &&
        missingCoverLetterForCurrentVacancy;

      if (
        hasPendingCurrentVacancy &&
        this.isHhVacancyDetailUrl(currentUrl) &&
        effectiveCall.name === "navigate_to_url"
      ) {
        const leavingCurrentVacancy =
          !targetUrl || !this.isHhVacancyDetailUrl(targetUrl) || targetUrl !== currentUrl;
        if (leavingCurrentVacancy) {
          this.options.logger.logStatus(
            `Step ${step}: job policy prevented leaving opened vacancy before apply attempt.`,
          );
          effectiveCall = {
            ...effectiveCall,
            name: "query_dom",
            arguments: this.stringifyToolArgs({
              question:
                "Find the primary apply/respond button on this vacancy page.",
              maxResults: 8,
            }),
          };
        }
      }

      if (
        coverLetterStepRequiredNow
      ) {
        const tryingToLeaveForOtherStep =
          effectiveCall.name === "navigate_to_url" ||
          effectiveCall.name === "go_back" ||
          effectiveCall.name === "finish_task";
        if (tryingToLeaveForOtherStep) {
          this.options.logger.logStatus(
            `Step ${step}: job policy blocked leaving vacancy flow before cover letter is filled.`,
          );
          effectiveCall = {
            ...effectiveCall,
            name: "query_dom",
            arguments: this.stringifyToolArgs({
              question:
                "Locate the cover-letter text field and the final apply/submit control on this response flow.",
              maxResults: 8,
            }),
          };
        }
      }

      if (effectiveCall.name === "extract_text") {
        const elementId = typeof args.elementId === "string" ? args.elementId.trim() : "";
        if (!elementId) {
          this.options.logger.logStatus(
            `Step ${step}: job policy redirected extract_text with empty elementId -> get_page_state.`,
          );
          effectiveCall = {
            ...effectiveCall,
            name: "get_page_state",
            arguments: this.stringifyToolArgs({
              note: "Refresh page state and choose a valid visible elementId before extract_text.",
            }),
          };
        } else if (["body", "main", "root", "document"].includes(elementId.toLowerCase())) {
          this.options.logger.logStatus(
            `Step ${step}: job policy redirected extract_text(${elementId}) -> query_dom for actionable element.`,
          );
          effectiveCall = {
            ...effectiveCall,
            name: "query_dom",
            arguments: this.stringifyToolArgs({
              question:
                "Find visible actionable elements for the next step (vacancy row/link, apply button, cover letter field).",
              maxResults: 8,
            }),
          };
        }
      }

      if (effectiveCall.name === "navigate_to_url" && targetUrl) {
        if (/https?:\/\/(?:www\.)?hh\.ru\/applicant(?:\/|\?|$)/i.test(targetUrl)) {
          this.options.logger.logStatus(
            `Step ${step}: job policy redirected navigate_to_url ${targetUrl} -> https://hh.ru/applicant/resumes`,
          );
          effectiveCall = {
            ...effectiveCall,
            name: "navigate_to_url",
            arguments: this.stringifyToolArgs({
              url: "https://hh.ru/applicant/resumes",
            }),
          };
        }

        const updatedArgs = this.parseToolArgs(effectiveCall.arguments);
        const updatedTargetUrl =
          typeof updatedArgs.url === "string" ? updatedArgs.url : targetUrl;

        if (
          hasProfileEvidence &&
          visitedVacancySearch &&
          this.isHhProfileLikeUrl(updatedTargetUrl)
        ) {
          this.options.logger.logStatus(
            `Step ${step}: job policy blocked repeated profile navigation -> continue vacancy search.`,
          );
          if (this.isHhVacancySearchUrl(currentUrl)) {
            effectiveCall = {
              ...effectiveCall,
              name: "query_dom",
              arguments: this.stringifyToolArgs({
                question:
                  "List relevant vacancy cards/links on the current search page and identify the next one to open.",
                maxResults: 10,
              }),
            };
          } else {
            effectiveCall = {
              ...effectiveCall,
              name: "navigate_to_url",
              arguments: this.stringifyToolArgs({
                url: this.buildJobSearchUrl(),
              }),
            };
          }
        }

        if (
          hasProfileEvidence &&
          visitedVacancySearch &&
          /https?:\/\/(?:www\.)?hh\.ru\/?(?:\?|$)/i.test(updatedTargetUrl)
        ) {
          this.options.logger.logStatus(
            `Step ${step}: job policy blocked root navigation during active vacancy flow.`,
          );
          effectiveCall = {
            ...effectiveCall,
            name: "navigate_to_url",
            arguments: this.stringifyToolArgs({
              url: this.buildJobSearchUrl(),
            }),
          };
        }
      }

      if (
        hasProfileEvidence &&
        visitedVacancySearch &&
        this.isHhVacancySearchUrl(currentUrl) &&
        (effectiveCall.name === "query_dom" || effectiveCall.name === "get_page_state")
      ) {
        const queryText =
          effectiveCall.name === "query_dom"
            ? String(this.parseToolArgs(effectiveCall.arguments).question ?? "")
            : String(this.parseToolArgs(effectiveCall.arguments).note ?? "");
        if (/(resume|cv|profile|резюм|профил)/i.test(queryText)) {
          this.options.logger.logStatus(
            `Step ${step}: job policy redirected ${effectiveCall.name} resume-inspection on vacancy search page -> vacancy list inspection.`,
          );
          effectiveCall = {
            ...effectiveCall,
            name: "query_dom",
            arguments: this.stringifyToolArgs({
              question:
                "List relevant vacancy cards/links on the current search page and identify the best next one to open.",
              maxResults: 10,
            }),
          };
        }
      }

      if (
        call.name === "finish_task" &&
        effectiveCall.name === "query_dom" &&
        jobRuntime.extractedVacancyFingerprints.size < targetApplyCount
      ) {
        const question = String(this.parseToolArgs(effectiveCall.arguments).question ?? "");
        const asksForVacancyList = /vacancy\s+search\s+results\s+list|next\s+relevant\s+vacancy|cards\/links|identify the next/i.test(
          question,
        );
        const onVacancyFlowPage =
          this.isHhVacancySearchUrl(currentUrl) ||
          this.isHhVacancyDetailUrl(currentUrl) ||
          this.isHhVacancyResponseUrl(currentUrl);

        if (asksForVacancyList && !onVacancyFlowPage) {
          this.options.logger.logStatus(
            `Step ${step}: job anti-loop redirected finish_task recovery query -> vacancy search page.`,
          );
          effectiveCall = {
            ...effectiveCall,
            name: "navigate_to_url",
            arguments: this.stringifyToolArgs({
              url: this.buildJobSearchUrl(),
            }),
          };
        }
      }

      if (
        hasProfileEvidence &&
        visitedVacancySearch &&
        (effectiveCall.name === "click_element" || effectiveCall.name === "scroll") &&
        this.isHhProfileLikeUrl(currentUrl)
      ) {
        this.options.logger.logStatus(
          `Step ${step}: job policy redirected ${effectiveCall.name} on profile page -> vacancy search.`,
        );
        effectiveCall = {
          ...effectiveCall,
          name: "navigate_to_url",
          arguments: this.stringifyToolArgs({
            url: this.buildJobSearchUrl(),
          }),
        };
      }
    }

    const jobRuntime = this.options.runtimeStats.jobApplication;
    const profileContextStillRequired =
      !jobRuntime.enabled ||
      (jobRuntime.extractedVacancyFingerprints.size === 0 &&
        jobRuntime.appliedVacancyFingerprints.size === 0);

    if (
      effectiveCall.name === "finish_task" &&
      this.options.taskPolicy.jobApplicationFlow &&
      this.options.taskPolicy.profileResumeContextRequired &&
      profileContextStillRequired &&
      !this.hasProfileResumeEvidence(state)
    ) {
      this.options.logger.logStatus(
        `Step ${step}: finish_task blocked by job policy until profile/resume context is extracted.`,
      );
      const result = await this.options.toolRegistry.execute(
        "query_dom",
        this.stringifyToolArgs({
          question:
            "Where is the user's profile/resume on this site, and what key skills/experience are visible?",
          maxResults: 8,
        }),
      );
      return { result, executedToolName: "query_dom" };
    }

    if (
      effectiveCall.name === "request_user_input" &&
      this.options.taskPolicy.suppressUnnecessaryUserQuestions &&
      !hasBlockingSignals(state.latestSignals)
    ) {
      this.options.logger.logStatus(
        `Step ${step}: request_user_input suppressed by policy (fully-specified task). Continuing autonomously.`,
      );
      return {
        result: {
          ok: true,
          observation: {
            question: "suppressed_by_policy",
            message:
              "The task is fully specified and not blocked by login/captcha/payment/destructive ambiguity. Continue execution.",
            policyAction: "continue_execution",
            userResponse:
              "AUTO: continue autonomously using available on-page/profile facts; do not ask the user.",
          },
        },
        executedToolName: "request_user_input",
      };
    }

    const result = await this.options.toolRegistry.execute(
      effectiveCall.name,
      effectiveCall.arguments,
    );
    return { result, executedToolName: effectiveCall.name };
  }

  async run(goal: string): Promise<AgentRunResult> {
    const state = createInitialState(goal);
    const tools = this.options.toolRegistry.getOpenAITools() as any;
    const suppressAssistantIntent = this.options.taskPolicy.suppressIntermediateAssistantText;

    let response = await this.options.client.responses.create({
      model: this.options.model,
      instructions: SYSTEM_PROMPT,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `User goal: ${goal}`,
            },
          ],
        },
      ] as any,
      tools,
    });

    for (let step = 1; step <= this.maxSteps; step += 1) {
      const assistantIntent = extractAssistantIntent(response);
      if (assistantIntent && !suppressAssistantIntent) {
        this.options.logger.logAssistantIntent(step, assistantIntent);
      }

      const functionCalls = extractFunctionCalls(response);

      if (functionCalls.length === 0) {
        if (step >= this.maxSteps) {
          const report = buildFinalReport(
            "max_steps_reached",
            "Reached max steps without explicit finish_task.",
            step,
            state,
          );
          return { report, state };
        }

        if (this.shouldResetContext(step)) {
          this.options.logger.logStatus(
            `Step ${step}: resetting model context (no tool call in response).`,
          );
          response = await this.options.client.responses.create({
            model: this.options.model,
            instructions: SYSTEM_PROMPT,
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: this.buildContextResetPrompt(goal, state, step),
                  },
                ],
              },
            ] as any,
            tools,
          });
          continue;
        }

        response = await this.options.client.responses.create({
          model: this.options.model,
          previous_response_id: response.id,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Call exactly one next tool or finish_task. Do not stop at explanation only.",
                },
              ],
            },
          ] as any,
          tools,
        });
        continue;
      }

      if (functionCalls.length > 1) {
        this.options.logger.logStatus(
          `Модель вернула ${functionCalls.length} вызовов инструментов на шаге ${step}. Выполняю только первый, остальные помечаю как пропущенные.`,
        );
      }

      const call = functionCalls[0];
      this.options.logger.logToolCall(step, call.name, call.arguments);
      const startedAt = Date.now();
      const execution = await this.executeCallWithPolicy(call, state, step);
      const result = execution.result;
      const durationMs = Date.now() - startedAt;
      if (execution.executedToolName !== call.name) {
        this.options.logger.logStatus(
          `Step ${step}: executed tool ${execution.executedToolName} instead of requested ${call.name} due to policy steering.`,
        );
      }
      this.options.logger.logToolResult(step, call.name, result, durationMs);

      updateStateFromToolResult(state, execution.executedToolName, result);

      const toolOutputs: any[] = [
        {
          type: "function_call_output",
          call_id: call.callId,
          output: this.serializeToolResultForModel(result),
        },
      ];

      for (let index = 1; index < functionCalls.length; index += 1) {
        const skippedCall = functionCalls[index];
        toolOutputs.push({
          type: "function_call_output",
          call_id: skippedCall.callId,
          output: JSON.stringify({
            ok: false,
            observation: {
              message:
                "This call was skipped: only one meaningful action is executed per step.",
              skippedToolName: skippedCall.name,
            },
            error: "skipped_by_single_action_policy",
            control: null,
          }),
        });
      }

      if (result.control?.type === "finish") {
        const report = buildFinalReport(
          result.control.status,
          result.control.summary,
          step,
          state,
        );
        return { report, state };
      }

      if (result.control?.type === "blocked") {
        const report = buildFinalReport("blocked", result.control.reason, step, state);
        return { report, state };
      }

      const continuedResponse = await this.options.client.responses.create({
        model: this.options.model,
        previous_response_id: response.id,
        input: toolOutputs as any,
        tools,
      });

      if (this.shouldResetContext(step)) {
        this.options.logger.logStatus(
          `Step ${step}: compacting context and starting a fresh response chain.`,
        );
        response = await this.options.client.responses.create({
          model: this.options.model,
          instructions: SYSTEM_PROMPT,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: this.buildContextResetPrompt(goal, state, step),
                },
              ],
            },
          ] as any,
          tools,
        });
      } else {
        response = continuedResponse;
      }
    }

    const fallbackReport = buildFinalReport(
      "max_steps_reached",
      "Reached max steps without finish_task.",
      this.maxSteps,
      state,
    );
    return { report: fallbackReport, state };
  }
}
