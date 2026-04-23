import { AgentRunResult, TaskPolicy } from "../../types";

export interface SubAgent {
  readonly id: string;
  readonly description: string;
  supports(goal: string, policy: TaskPolicy): boolean;
  run(goal: string, policy: TaskPolicy): Promise<AgentRunResult>;
}

export interface SubAgentRunOutcome {
  selectedAgentId: string;
  fallbackAgentId?: string;
  result: AgentRunResult;
}
