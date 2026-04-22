import { BrowserAgent } from "../browser-agent";
import { TaskPolicy } from "../../types";
import { SubAgent } from "./types";

type AgentFactory = () => BrowserAgent;

const HH_HINT_RE = /\b(?:hh\.ru|headhunter|head hunter|хх\.ру|хх)\b/i;

export class HhJobApplicationSubAgent implements SubAgent {
  readonly id = "hh-job-application";
  readonly description =
    "Specialized hh.ru job-application agent with deterministic stage guidance.";

  constructor(private readonly createAgent: AgentFactory) {}

  supports(goal: string, policy: TaskPolicy): boolean {
    return policy.jobApplicationFlow && HH_HINT_RE.test(goal);
  }

  async run(goal: string) {
    const agent = this.createAgent();
    const specializedGoal = `${goal}

Sub-agent specialization (hh.ru fast lane):
- Work on hh.ru end-to-end unless blocked by login/captcha.
- Follow this strict sequence:
  1) PROFILE_REVIEW: open applicant profile/resume, scroll to the latest work experience, extract it into known facts.
  2) VACANCY_SEARCH: search vacancies using the requested role/query.
  3) OPEN_FIRST_RELEVANT: open the first relevant vacancy from fresh search results.
  4) VACANCY_ANALYSIS: extract title, company, requirements/responsibilities, and key constraints.
  5) APPLY: click "Откликнуться"/Apply, fill a short personalized cover letter from profile experience + vacancy requirements, submit one response.
  6) COMPLETE: finish immediately after one successful response with a concise report.
- Never loop back to the hh.ru homepage after vacancy details are open.
- If element IDs become stale, refresh with get_page_state/query_dom and continue the same stage.`;
    return agent.run(specializedGoal);
  }
}

