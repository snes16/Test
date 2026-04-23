import { BrowserAgent } from "../browser-agent";
import { TaskPolicy } from "../../types";
import { SubAgent } from "./types";

type AgentFactory = () => BrowserAgent;

export class JobApplicationSubAgent implements SubAgent {
  readonly id = "job-application";
  readonly description =
    "Specialized job-application agent with deterministic stage guidance.";

  constructor(private readonly createAgent: AgentFactory) {}

  supports(_goal: string, policy: TaskPolicy): boolean {
    return policy.jobApplicationFlow;
  }

  async run(goal: string, policy: TaskPolicy) {
    const agent = this.createAgent();
    const targetApplyCount = Math.max(1, policy.requestedJobApplyCount ?? 1);
    const specializedGoal = `${goal}

Sub-agent specialization (job-application fast lane):
- Work on the current job platform end-to-end unless blocked by login/captcha.
- Follow this strict sequence:
  1) PROFILE_REVIEW: open applicant profile/resume and extract key skills and experience into known facts.
  2) VACANCY_SEARCH: search vacancies using the requested role/query.
  3) OPEN_RELEVANT: open relevant vacancies from fresh search results one by one.
  4) VACANCY_ANALYSIS: for each opened vacancy extract title, company, requirements, salary, and location.
  5) APPLY: click Apply/Respond, write a short personalized cover letter from profile facts + vacancy requirements, and submit only for strong matches.
  6) LOOP: continue until ${targetApplyCount} successful response(s) are completed, then finish with a concise report.
- Avoid jumping to unrelated sites while the vacancy flow is active.
- If element IDs become stale, refresh with get_page_state/query_dom and continue the same stage.`;
    return agent.run(specializedGoal);
  }
}
