import { BrowserAgent } from "../browser-agent";
import { TaskPolicy } from "../../types";
import { SubAgent } from "./types";

type AgentFactory = () => BrowserAgent;

export class MailboxAuditSubAgent implements SubAgent {
  readonly id = "mailbox-audit";
  readonly description = "Specialized agent for read-only mailbox review and classification tasks.";

  constructor(private readonly createAgent: AgentFactory) {}

  supports(_goal: string, policy: TaskPolicy): boolean {
    return policy.auditReadOnlyMailboxScan;
  }

  async run(goal: string) {
    const agent = this.createAgent();
    const specializedGoal = `${goal}

Sub-agent specialization:
- You are selected as mailbox-audit agent for a read-only mailbox scan.
- Preserve the read-only behavior and complete the full inbox scan loop before finish_task.`;
    return agent.run(specializedGoal);
  }
}
