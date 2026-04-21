import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runAgentSession } from "./run-session";

interface CliArgs {
  task?: string;
  startUrl?: string;
  maxSteps?: number;
  slowMoMs?: number;
  cdpUrl?: string;
  userDataDir?: string;
  profileDirectory?: string;
  browserChannel?: "chrome" | "msedge" | "chromium";
}

function parsePositiveIntFromEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function parseBrowserChannelFromEnv():
  | "chrome"
  | "msedge"
  | "chromium"
  | undefined {
  const raw = process.env.AGENT_BROWSER_CHANNEL?.trim().toLowerCase();
  if (!raw) {
    return undefined;
  }
  if (raw === "chrome" || raw === "msedge" || raw === "chromium") {
    return raw;
  }
  return undefined;
}

function applyEnvDefaults(cliArgs: CliArgs): CliArgs {
  return {
    ...cliArgs,
    cdpUrl: cliArgs.cdpUrl?.trim() || process.env.AGENT_CDP_URL?.trim() || undefined,
    // startUrl must be explicit per run (`--start-url`) to keep the agent generic.
    startUrl: cliArgs.startUrl?.trim() || undefined,
    userDataDir:
      cliArgs.userDataDir?.trim() || process.env.AGENT_USER_DATA_DIR?.trim() || undefined,
    profileDirectory:
      cliArgs.profileDirectory?.trim() ||
      process.env.AGENT_PROFILE_DIRECTORY?.trim() ||
      undefined,
    browserChannel: cliArgs.browserChannel || parseBrowserChannelFromEnv(),
    maxSteps: cliArgs.maxSteps ?? parsePositiveIntFromEnv("AGENT_MAX_STEPS"),
    slowMoMs: cliArgs.slowMoMs ?? parsePositiveIntFromEnv("AGENT_SLOW_MO_MS"),
  };
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--task") {
      args.task = argv[i + 1];
      i += 1;
      continue;
    }
    if (current === "--start-url") {
      args.startUrl = argv[i + 1];
      i += 1;
      continue;
    }
    if (current === "--max-steps") {
      args.maxSteps = Number.parseInt(argv[i + 1] ?? "", 10);
      i += 1;
      continue;
    }
    if (current === "--slow-mo-ms") {
      args.slowMoMs = Number.parseInt(argv[i + 1] ?? "", 10);
      i += 1;
      continue;
    }
    if (current === "--cdp-url") {
      args.cdpUrl = argv[i + 1];
      i += 1;
      continue;
    }
    if (current === "--user-data-dir") {
      args.userDataDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (current === "--profile-directory") {
      args.profileDirectory = argv[i + 1];
      i += 1;
      continue;
    }
    if (current === "--browser-channel") {
      const candidate = argv[i + 1];
      if (candidate === "chrome" || candidate === "msedge" || candidate === "chromium") {
        args.browserChannel = candidate;
      }
      i += 1;
      continue;
    }

    positional.push(current);
  }

  if (!args.task && positional.length > 0) {
    // Some shells/npm invocations may strip option names and leave only values.
    // Recover best-effort values from positional arguments.
    const values = [...positional];
    const looksLikeUrl = (value: string) => /^https?:\/\//i.test(value);
    const looksLikeCdpUrl = (value: string) =>
      looksLikeUrl(value) && /(?:127\.0\.0\.1|localhost):\d+/i.test(value);

    if (!args.cdpUrl) {
      const cdpIndex = values.findIndex(looksLikeCdpUrl);
      if (cdpIndex >= 0) {
        args.cdpUrl = values[cdpIndex];
        values.splice(cdpIndex, 1);
      }
    }

    if (!args.startUrl) {
      const startIndex = values.findIndex(looksLikeUrl);
      if (startIndex >= 0) {
        args.startUrl = values[startIndex];
        values.splice(startIndex, 1);
      }
    }

    if (!args.maxSteps) {
      const stepsIndex = values.findIndex((value) => /^\d+$/.test(value));
      if (stepsIndex >= 0) {
        args.maxSteps = Number.parseInt(values[stepsIndex], 10);
        values.splice(stepsIndex, 1);
      }
    }

    if (values.length > 0) {
      args.task = values.join(" ");
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = applyEnvDefaults(parseCliArgs(process.argv.slice(2)));
  const rl = createInterface({ input, output });

  try {
    const task =
      args.task?.trim() ||
      (
        await rl.question(
          "Введите задачу для браузерного агента на естественном языке:\n> ",
        )
      ).trim();

    if (!task) {
      throw new Error("Нужно указать задачу.");
    }

    const result = await runAgentSession({
      task,
      startUrl: args.startUrl?.trim(),
      maxSteps: args.maxSteps,
      slowMoMs: args.slowMoMs,
      cdpUrl: args.cdpUrl?.trim(),
      userDataDir: args.userDataDir?.trim(),
      profileDirectory: args.profileDirectory?.trim(),
      browserChannel: args.browserChannel,
      askUserInput: async (question: string) => {
        const answer = await rl.question(`\nТРЕБУЕТСЯ ВВОД ПОЛЬЗОВАТЕЛЯ\n${question}\n> `);
        return answer.trim();
      },
    });

    console.log(`\nФайл лога: ${result.logFilePath}`);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Критическая ошибка: ${message}`);
  process.exitCode = 1;
});
