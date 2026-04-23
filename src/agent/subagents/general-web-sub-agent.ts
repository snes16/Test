import { BrowserAgent } from "../browser-agent";
import { TaskPolicy } from "../../types";
import { SubAgent } from "./types";

type AgentFactory = () => BrowserAgent;

export class GeneralWebSubAgent implements SubAgent {
  readonly id = "general-web";
  readonly description = "Default browser agent for generic web tasks.";

  constructor(private readonly createAgent: AgentFactory) {}

  supports(): boolean {
    return true;
  }

  async run(goal: string, _policy: TaskPolicy) {
    const agent = this.createAgent();
    return agent.run(goal);
  }
}
