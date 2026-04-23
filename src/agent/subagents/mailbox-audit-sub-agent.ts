import { BrowserAgent } from "../browser-agent";
import { TaskPolicy } from "../../types";
import { SubAgent } from "./types";

type AgentFactory = () => BrowserAgent;

export class MailboxAuditSubAgent implements SubAgent {
  readonly id = "mailbox-audit";
  readonly description = "Specialized agent for mailbox review/classification and spam-cleanup tasks.";

  constructor(private readonly createAgent: AgentFactory) {}

  supports(_goal: string, policy: TaskPolicy): boolean {
    return policy.mailboxScanFlow;
  }

  async run(goal: string, policy: TaskPolicy) {
    const agent = this.createAgent();
    const modeLine = policy.mailboxDeleteRequested
      ? "- This is a spam-cleanup mailbox task: after extracting content, delete/move-to-spam only clearly suspicious messages."
      : policy.mailboxReadOnly
        ? "- This is a read-only mailbox scan: do not delete/archive anything."
        : "- This is a mailbox classification task: inspect full content and classify suspicious vs normal.";
    const verificationLine = policy.mailboxDeleteVerificationCodes
      ? "- Verification-code emails are also deletion candidates in this run."
      : "";

    const specializedGoal = `${goal}

Sub-agent specialization:
- You are selected as mailbox-audit agent for mailbox scan automation.
${modeLine}
${verificationLine}
- Complete the full inbox scan loop before finish_task.`;
    return agent.run(specializedGoal);
  }
}
