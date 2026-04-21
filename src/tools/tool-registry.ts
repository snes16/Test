import { ZodTypeAny } from "zod";
import { BrowserManager } from "../browser/browser-manager";
import { PageInspector } from "../observation/page-inspector";
import { MailboxScanRuntime, TaskPolicy, ToolExecutionResult } from "../types";

export interface RuntimeStats {
  clickedElementIds: Set<string>;
  clickedListItemIds: Set<string>;
  clickedListSignatures: Set<string>;
  extractedElementIds: Set<string>;
  scrollActions: number;
  goBackActions: number;
  cartAddActions: number;
  cartAddSkips: number;
  policy: TaskPolicy;
  mailboxScan: MailboxScanRuntime;
}

export interface ToolContext {
  browser: BrowserManager;
  inspector: PageInspector;
  artifactsDir: string;
  askUserInput: (question: string) => Promise<string>;
  userGoal: string;
  runtimeStats: RuntimeStats;
}

export interface ToolSpec<TSchema extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  schema: TSchema;
  execute: (args: any, context: ToolContext) => Promise<ToolExecutionResult>;
}

async function showRuntimeToolBadge(context: ToolContext, toolName: string): Promise<void> {
  try {
    const page = context.browser.getPage();
    await page.evaluate(({ name }) => {
      const elementId = "__agent_tool_badge";
      let badge = document.getElementById(elementId);
      if (!badge) {
        badge = document.createElement("div");
        badge.id = elementId;
        Object.assign(badge.style, {
          position: "fixed",
          top: "14px",
          right: "14px",
          zIndex: "2147483647",
          pointerEvents: "none",
          padding: "8px 12px",
          borderRadius: "999px",
          background: "rgba(18, 18, 24, 0.85)",
          color: "#f6f7fb",
          fontSize: "12px",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          border: "1px solid rgba(255,255,255,0.18)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
          transition: "opacity 180ms ease, transform 180ms ease",
          opacity: "0",
          transform: "translateY(-4px)",
        });
        document.documentElement.appendChild(badge);
      }

      const host = badge as HTMLDivElement & { __hideTimer?: number };
      host.textContent = `Агент: ${name}`;
      host.style.opacity = "1";
      host.style.transform = "translateY(0)";

      if (host.__hideTimer) {
        window.clearTimeout(host.__hideTimer);
      }
      host.__hideTimer = window.setTimeout(() => {
        host.style.opacity = "0.25";
        host.style.transform = "translateY(-2px)";
      }, 1300);
    }, { name: toolName });
  } catch {
    // Non-fatal: badge rendering is only for observability.
  }
}

export class ToolRegistry {
  private readonly toolsByName = new Map<string, ToolSpec>();

  constructor(
    private readonly context: ToolContext,
    tools: ToolSpec[],
  ) {
    for (const tool of tools) {
      this.toolsByName.set(tool.name, tool);
    }
  }

  getOpenAITools(): Array<Record<string, unknown>> {
    return Array.from(this.toolsByName.values()).map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  async execute(toolName: string, rawArguments: string | Record<string, unknown>) {
    const tool = this.toolsByName.get(toolName);
    if (!tool) {
      return {
        ok: false,
        error: `Unknown tool "${toolName}"`,
        observation: {
          message: `Unknown tool "${toolName}".`,
        },
      } satisfies ToolExecutionResult;
    }

    let parsedArguments: unknown = rawArguments;
    if (typeof rawArguments === "string") {
      try {
        parsedArguments = rawArguments.length > 0 ? JSON.parse(rawArguments) : {};
      } catch {
        return {
          ok: false,
          error: `Invalid JSON arguments for tool "${toolName}"`,
          observation: {
            message: "Tool arguments were not valid JSON.",
            rawArguments,
          },
        } satisfies ToolExecutionResult;
      }
    }

    const validated = tool.schema.safeParse(parsedArguments);
    if (!validated.success) {
      return {
        ok: false,
        error: `Argument validation failed for tool "${toolName}"`,
        observation: {
          message: "Tool arguments failed validation.",
          issues: validated.error.issues,
        },
      } satisfies ToolExecutionResult;
    }

    try {
      await showRuntimeToolBadge(this.context, toolName);
      return await tool.execute(validated.data, this.context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: message,
        observation: {
          message: `Tool "${toolName}" failed.`,
          error: message,
        },
      } satisfies ToolExecutionResult;
    }
  }
}
