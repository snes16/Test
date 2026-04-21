import { mkdir } from "node:fs/promises";
import path from "node:path";
import { BrowserAgent } from "../agent/browser-agent";
import { createOpenAIClientFromEnv, getModelFromEnv } from "../agent/openai-client";
import { GeneralWebSubAgent } from "../agent/subagents/general-web-sub-agent";
import { MailboxAuditSubAgent } from "../agent/subagents/mailbox-audit-sub-agent";
import { SubAgentRouter } from "../agent/subagents/sub-agent-router";
import { createTaskPolicy } from "../agent/task-policy";
import { BrowserManager } from "../browser/browser-manager";
import { PageInspector } from "../observation/page-inspector";
import { createToolDefinitions } from "../tools/tool-definitions";
import { RuntimeStats, ToolRegistry } from "../tools/tool-registry";
import { AgentRunResult } from "../types";
import { ConsoleLogger } from "./console-logger";

export interface SessionOptions {
  task: string;
  startUrl?: string;
  maxSteps?: number;
  slowMoMs?: number;
  artifactsDir?: string;
  cdpUrl?: string;
  userDataDir?: string;
  profileDirectory?: string;
  browserChannel?: "chrome" | "msedge" | "chromium";
  askUserInput: (question: string) => Promise<string>;
}

export interface SessionResult {
  runResult: AgentRunResult;
  logFilePath: string;
}

function hostFromUrl(input: string | undefined): string | null {
  if (!input) {
    return null;
  }

  try {
    return new URL(input).host.toLowerCase();
  } catch {
    return null;
  }
}

function isSameHost(left: string | undefined, right: string | undefined): boolean {
  const leftHost = hostFromUrl(left);
  const rightHost = hostFromUrl(right);
  if (!leftHost || !rightHost) {
    return false;
  }
  return leftHost === rightHost;
}

function isRecoverableNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("frame has been detached") ||
    lower.includes("target page, context or browser has been closed") ||
    lower.includes("execution context was destroyed")
  );
}

function parseBooleanFromEnv(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return false;
  }
  return ["1", "true", "yes", "on", "enabled"].includes(raw);
}

async function gotoStartUrlWithRecovery(
  browser: BrowserManager,
  logger: ConsoleLogger,
  startUrl: string,
): Promise<void> {
  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const useFreshPage = attempt > 1;
    const page = await browser.ensureActivePage(startUrl, useFreshPage);

    try {
      await page.goto(startUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      await page.waitForTimeout(300);
      return;
    } catch (error) {
      lastError = error;
      if (!isRecoverableNavigationError(error)) {
        throw error;
      }

      if (attempt < maxAttempts) {
        logger.logStatus(
          `Вкладка стала недоступной во время перехода (попытка ${attempt}/${maxAttempts}). Открываю новую вкладку и повторяю...`,
        );
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function runAgentSession(options: SessionOptions): Promise<SessionResult> {
  const artifactsDir = path.resolve(options.artifactsDir ?? "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  const logger = new ConsoleLogger(artifactsDir);
  const client = createOpenAIClientFromEnv();
  const model = getModelFromEnv();
  const taskPolicy = createTaskPolicy(options.task);
  const enableSubAgents = parseBooleanFromEnv("AGENT_ENABLE_SUBAGENTS");

  logger.logStatus("Инициализация сессии браузера...");

  const browser = new BrowserManager({
    headless: false,
    slowMoMs: options.slowMoMs ?? 90,
    cdpUrl: options.cdpUrl,
    preferredPageUrl: options.startUrl,
    userDataDir: options.userDataDir,
    profileDirectory: options.profileDirectory,
    browserChannel: options.browserChannel,
  });

  if (options.cdpUrl) {
    logger.logStatus(`Подключение к открытому браузеру через CDP: ${options.cdpUrl}`);
  }

  if (options.userDataDir) {
    logger.logStatus(
      `Используется постоянный профиль браузера из "${options.userDataDir}"` +
        (options.profileDirectory ? ` (профиль: ${options.profileDirectory})` : ""),
    );
  }

  await browser.start();
  logger.logStatus("Браузер запущен в видимом режиме.");

  try {
    let effectiveTask = options.task;
    if (options.startUrl) {
      if (options.cdpUrl) {
        const switched = await browser.switchToBestPage(options.startUrl);
        if (switched.switched) {
          logger.logStatus(`Повторно используем уже открытую вкладку: ${switched.selectedUrl}`);
        } else {
          logger.logStatus(`Текущая подключенная вкладка: ${switched.selectedUrl}`);
        }
      }

      const currentPage = await browser.ensureActivePage(options.startUrl);
      const currentUrlBeforeNavigate = currentPage.url();
      if (isSameHost(options.startUrl, currentUrlBeforeNavigate)) {
        logger.logStatus(
          `Остаемся на текущей вкладке: домен уже совпадает со стартовым URL (${currentUrlBeforeNavigate})`,
        );
      } else {
        logger.logStatus(`Открываю стартовый URL: ${options.startUrl}`);
        await gotoStartUrlWithRecovery(browser, logger, options.startUrl);
      }

      const current = browser.getPage().url();
      effectiveTask = `${options.task}

Дополнительный контекст выполнения:
- Браузер уже открыт на странице: ${current}
- Начинай работу с этой страницы.
- Предпочитай выполнять цель на текущем сайте, прежде чем переходить на внешние сайты.
- Если переход на внешний сайт необходим, сначала кратко объясни причину в намерении.`;
    }

    const runtimeStats: RuntimeStats = {
      clickedElementIds: new Set<string>(),
      clickedListItemIds: new Set<string>(),
      clickedListSignatures: new Set<string>(),
      extractedElementIds: new Set<string>(),
      scrollActions: 0,
      goBackActions: 0,
      cartAddActions: 0,
      cartAddSkips: 0,
      policy: taskPolicy,
      mailboxScan: {
        enabled: taskPolicy.auditReadOnlyMailboxScan,
        requestedCount: taskPolicy.requestedItemCount ?? 0,
        stage: taskPolicy.auditReadOnlyMailboxScan ? "INBOX_LISTING" : "IDLE",
        listGeneration: 0,
        nextCandidateIndex: 0,
        latestListCandidates: [],
        pendingCandidate: null,
        visitedMessages: new Map(),
        visitedPreviewFingerprints: new Set(),
        duplicateSkips: 0,
        staleRecoveries: 0,
      },
    };

    const inspector = new PageInspector(browser);
    const toolRegistry = new ToolRegistry(
      {
        browser,
        inspector,
        artifactsDir,
        askUserInput: options.askUserInput,
        userGoal: options.task,
        runtimeStats,
      },
      createToolDefinitions(),
    );

    const createAgent = () =>
      new BrowserAgent({
        client,
        model,
        toolRegistry,
        runtimeStats,
        logger,
        maxSteps: options.maxSteps ?? 50,
        taskPolicy,
      });

    logger.logStatus("Цикл агента запущен.");
    let runResult: AgentRunResult;
    if (enableSubAgents) {
      const router = new SubAgentRouter(
        [new MailboxAuditSubAgent(createAgent), new GeneralWebSubAgent(createAgent)],
        logger,
      );
      const routed = await router.run(effectiveTask, taskPolicy);
      if (routed.fallbackAgentId) {
        logger.logStatus(
          `Sub-agent fallback applied: ${routed.selectedAgentId} -> ${routed.fallbackAgentId}.`,
        );
      }
      runResult = routed.result;
    } else {
      const agent = createAgent();
      runResult = await agent.run(effectiveTask);
    }
    logger.logFinalReport(runResult.report);

    return {
      runResult,
      logFilePath: logger.getLogFilePath(),
    };
  } finally {
    logger.logStatus("Закрываю браузер...");
    await browser.close();
  }
}
