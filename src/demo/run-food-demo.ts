import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runAgentSession } from "../cli/run-session";
import { startFoodDemoServer } from "./food-site";

const DEFAULT_DEMO_TASK =
  "Use only the currently opened demo website. Do not navigate to external domains. Add one Margherita Pizza and one Cola to the cart, proceed through checkout, fill delivery details with realistic placeholder data, continue until the payment confirmation screen, stop before final payment, and then provide a final report.";

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const server = await startFoodDemoServer();
  const autoMode = hasFlag("--auto");
  const rl = autoMode ? null : createInterface({ input, output });

  console.log(`Food demo site is running at ${server.url}`);
  console.log(`Default task:\n${DEFAULT_DEMO_TASK}\n`);

  try {
    let customTask = "";
    if (rl) {
      customTask = (
        await rl.question("Press Enter to use default demo task, or type a custom task:\n> ")
      ).trim();
    }

    const task = customTask || DEFAULT_DEMO_TASK;
    await runAgentSession({
      task,
      startUrl: server.url,
      maxSteps: 55,
      slowMoMs: 110,
      askUserInput: async (question: string) => {
        if (!rl) {
          return `Auto response: stop before payment, provide final report. Original question: ${question}`;
        }
        const answer = await rl.question(`\nUSER INPUT REQUIRED\n${question}\n> `);
        return answer.trim();
      },
    });
  } finally {
    rl?.close();
    await server.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Demo failed: ${message}`);
  process.exitCode = 1;
});
