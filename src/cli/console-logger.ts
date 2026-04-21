import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { AgentLogger, FinalReport, ToolExecutionResult } from "../types";

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function nowLabel(): string {
  return new Date().toISOString();
}

function short(value: string, max = 700): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 3)}...`;
}

export class ConsoleLogger implements AgentLogger {
  private readonly logFilePath: string;

  constructor(private readonly artifactsDir: string) {
    const logsDir = path.join(artifactsDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.logFilePath = path.join(logsDir, `session-${stamp}.log`);
  }

  logStatus(message: string): void {
    const line = `[${nowLabel()}] СТАТУС: ${message}`;
    console.log(line);
    this.write(line);
  }

  logAssistantIntent(step: number, text: string): void {
    const line = `\nАссистент (шаг ${step}): ${text}\n`;
    console.log(line);
    this.write(line);
  }

  logToolCall(step: number, toolName: string, args: unknown): void {
    let parsedArgs: unknown = args;
    if (typeof args === "string") {
      try {
        parsedArgs = JSON.parse(args || "{}");
      } catch {
        parsedArgs = args;
      }
    }

    const line = `Вызов инструмента (шаг ${step}): ${toolName}\nВходные данные: ${safeJson(
      parsedArgs,
    )}\n`;
    console.log(line);
    this.write(line);
  }

  logToolResult(
    step: number,
    toolName: string,
    result: ToolExecutionResult,
    durationMs: number,
  ): void {
    const status = result.ok ? "УСПЕХ" : "ОШИБКА";
    const line =
      `Результат (шаг ${step}, ${toolName}, ${durationMs}мс): ${status}\n` +
      `Вывод: ${short(safeJson(result.observation))}\n`;
    console.log(line);
    this.write(line);
  }

  logFinalReport(report: FinalReport): void {
    const line = `\nИТОГОВЫЙ ОТЧЕТ\nСтатус: ${report.status}\nШагов выполнено: ${
      report.stepsExecuted
    }\nКратко: ${report.summary}\nИзвестные факты:\n- ${report.knownFacts.join(
      "\n- ",
    )}\nНерешенные вопросы:\n- ${report.unresolvedQuestions.join("\n- ")}\n`;
    console.log(line);
    this.write(line);
    this.logStatus(`Лог сессии сохранен: ${this.logFilePath}`);
  }

  getLogFilePath(): string {
    return this.logFilePath;
  }

  private write(content: string): void {
    appendFileSync(this.logFilePath, `${content}\n`, "utf8");
  }
}
