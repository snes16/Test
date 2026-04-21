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

function stringifyShort(value: unknown, max = 280): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (raw.length <= max) {
    return raw;
  }
  return `${raw.slice(0, max - 3)}...`;
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
  };
}

function updateStateFromToolResult(
  state: TaskState,
  toolName: string,
  result: ToolExecutionResult,
): void {
  state.completedActions.push(toolName);
  state.latestObservation = stringifyShort(result.observation, 600);

  if (toolName === "get_page_state" && result.ok) {
    const observation = result.observation as {
      summary?: string;
      url?: string;
      title?: string;
      signals?: TaskState["latestSignals"];
    };

    if (observation.summary) {
      state.currentPageSummary = observation.summary;
    }
    if (observation.signals) {
      state.latestSignals = observation.signals;
    }
    if (observation.url && observation.title) {
      const fact = `Observed page: ${observation.title} (${observation.url})`;
      if (!state.knownFacts.includes(fact)) {
        state.knownFacts.push(fact);
      }
    }
  }

  if (toolName === "query_dom" && result.ok) {
    const observation = result.observation as {
      answer?: string;
      signals?: TaskState["latestSignals"];
    };

    if (observation.signals) {
      state.latestSignals = observation.signals;
    }
    if (observation.answer) {
      const fact = `DOM query: ${observation.answer}`;
      if (!state.knownFacts.includes(fact)) {
        state.knownFacts.push(fact);
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

  constructor(private readonly options: BrowserAgentOptions) {
    this.maxSteps = options.maxSteps ?? 50;
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
  ): Promise<ToolExecutionResult> {
    const mailboxSteered = this.steerMailboxCall(call);
    const effectiveCall = mailboxSteered.call;

    if (mailboxSteered.redirected) {
      this.options.logger.logStatus(
        `Step ${step}: mailbox policy redirected ${call.name} -> ${effectiveCall.name}. ${mailboxSteered.reason ?? ""}`.trim(),
      );
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
        ok: false,
        error: "request_user_input_blocked_by_policy",
        observation: {
          question: "suppressed_by_policy",
          message:
            "The task is fully specified and not blocked by login/captcha/payment/destructive ambiguity. Continue execution.",
          policyAction: "continue_execution",
        },
      };
    }

    return this.options.toolRegistry.execute(effectiveCall.name, effectiveCall.arguments);
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
      const result = await this.executeCallWithPolicy(call, state, step);
      const durationMs = Date.now() - startedAt;
      this.options.logger.logToolResult(step, call.name, result, durationMs);

      updateStateFromToolResult(state, call.name, result);

      const toolOutputs: any[] = [
        {
          type: "function_call_output",
          call_id: call.callId,
          output: JSON.stringify({
            ok: result.ok,
            observation: result.observation,
            error: result.error ?? null,
            control: result.control ?? null,
          }),
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

      response = await this.options.client.responses.create({
        model: this.options.model,
        previous_response_id: response.id,
        input: toolOutputs as any,
        tools,
      });
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
