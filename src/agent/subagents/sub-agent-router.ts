import { AgentLogger, TaskPolicy } from "../../types";
import { SubAgent, SubAgentRunOutcome } from "./types";

export class SubAgentRouter {
  constructor(
    private readonly agents: SubAgent[],
    private readonly logger: AgentLogger,
    private readonly fallbackAgentId = "general-web",
  ) {
    if (agents.length === 0) {
      throw new Error("SubAgentRouter requires at least one agent.");
    }
  }

  private select(goal: string, policy: TaskPolicy): SubAgent {
    const selected = this.agents.find((agent) => agent.supports(goal, policy));
    return selected ?? this.agents[0];
  }

  private resolveFallbackAgent(primary: SubAgent): SubAgent {
    const configured =
      this.agents.find((agent) => agent.id === this.fallbackAgentId) ?? this.agents[0];
    if (configured.id === primary.id) {
      return primary;
    }
    return configured;
  }

  async run(goal: string, policy: TaskPolicy): Promise<SubAgentRunOutcome> {
    const selected = this.select(goal, policy);
    this.logger.logStatus(`Sub-agent selected: ${selected.id}.`);

    try {
      const result = await selected.run(goal);
      return {
        selectedAgentId: selected.id,
        result,
      };
    } catch (error) {
      const fallback = this.resolveFallbackAgent(selected);
      if (fallback.id === selected.id) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.logStatus(
        `Sub-agent ${selected.id} failed (${message}). Falling back to ${fallback.id}.`,
      );

      const result = await fallback.run(goal);
      return {
        selectedAgentId: selected.id,
        fallbackAgentId: fallback.id,
        result,
      };
    }
  }
}
