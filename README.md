# Autonomous Browser Agent MVP

TypeScript + Node.js + Playwright prototype of a small general-purpose autonomous browser agent.

It accepts a natural-language goal from terminal input, runs a tool-calling agent loop, controls a **headed** browser, logs each tool call in readable form, and ends with a short final report.

## What This Project Does

- Launches a real Chromium browser in headed mode.
- Accepts a free-form task from CLI.
- Uses an OpenAI-compatible function-calling loop to decide actions at runtime.
- Observes the page using structured extraction (not full HTML dumps).
- Executes one meaningful step at a time through tools.
- Pauses for user input when needed (login/captcha/payment ambiguity).
- Produces a final report with status, summary, known facts, and unresolved questions.

## Why This Architecture

The assignment asks for a general agent, not a hardcoded site bot.  
This implementation separates concerns so behavior stays generic:

- `src/agent/`: LLM loop, task state, stop conditions.
- `src/browser/`: Playwright lifecycle.
- `src/tools/`: compact tool layer with schemas + execution.
- `src/observation/`: runtime page extraction and DOM querying.
- `src/cli/`: terminal UX and readable logs.
- `src/demo/`: reliable end-to-end demo scenario.
- `src/types/`: shared contracts.

This keeps the system understandable and extensible while still being practical for MVP.

## Optional Sub-Agent Architecture

The project now supports an optional sub-agent router:

- `mailbox-audit` sub-agent: selected for read-only mailbox scan tasks.
- `general-web` sub-agent: default fallback for all other tasks.

Safety behavior:

- Sub-agents are **disabled by default**.
- Enable with `AGENT_ENABLE_SUBAGENTS=true`.
- If a specialized sub-agent fails, runtime automatically falls back to `general-web`.

## Agent Loop

Core runtime loop:

1. Receive user goal.
2. Model inspects/updates state via tools (`get_page_state`, `query_dom`, etc.).
3. Model chooses next tool call.
4. Tool executes one action and returns structured observation.
5. Observation is fed back to model.
6. Repeat until `finish_task`, blocked, or max-step limit.

Explicit task state is maintained:

- `userGoal`
- `knownFacts`
- `completedActions`
- `unresolvedQuestions`
- `currentPageSummary`
- `latestObservation`

## Page Understanding

`get_page_state` returns a compact structured snapshot:

- URL + title
- interactive elements
- form inputs
- important text blocks
- modal detection
- high-level page signals (login/captcha/payment/destructive hints)
- lightweight summary

### Runtime Element IDs

No predefined selectors are used.

- During observation, visible relevant DOM nodes are assigned runtime IDs via `data-agent-id` (e.g. `el_42`).
- Action tools (`click_element`, `type_text`, `extract_text`) operate on these IDs.
- If an ID goes stale, tools re-observe and retry.

This avoids brittle site-specific selectors and supports runtime discovery on unknown pages.

## Tool Set

Implemented tools:

- `navigate_to_url`
- `go_back`
- `take_screenshot`
- `get_page_state`
- `query_dom`
- `click_element`
- `type_text`
- `press_key`
- `scroll`
- `wait`
- `extract_text`
- `request_user_input`
- `finish_task`

Tools return concise structured observations for the next decision step.

## Safety Rules in Runtime

The prompt and tool flow enforce pause/clarification when:

- login is required
- 2FA/captcha appears
- payment confirmation is reached
- destructive action is ambiguous
- critical ambiguity remains

`request_user_input` pauses autonomy and asks the terminal user directly.

## Setup

## Prerequisites

- Node.js 20+
- npm
- OpenAI-compatible API key

## Install

```bash
npm install
npm run playwright:install
```

If Playwright cannot write to a global browser cache, install locally:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH='0'; npm run playwright:install
```

## Environment

Copy `.env.example` to `.env` and set at least:

```env
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini
```

Optional:

```env
OPENAI_BASE_URL=...
```

Optional runtime defaults (so you can run only `npm start` without long flags):

```env
AGENT_CDP_URL=http://127.0.0.1:9222
AGENT_MAX_STEPS=70
AGENT_SLOW_MO_MS=90
AGENT_ENABLE_SUBAGENTS=false
AGENT_PROFILE_DIRECTORY=Profile 4
AGENT_BROWSER_CHANNEL=chrome
```

`--start-url` is intentionally explicit per run and is not read from `.env`, so the agent is not pinned to one site.
CLI flags always override `.env` defaults.

## Run

Interactive mode:

```bash
npm run dev
```

Or with arguments:

```bash
npm run dev -- --task "Open example.com and summarize the homepage" --max-steps 40
```

Run with an existing Chrome/Edge profile (persistent logged-in session):

```powershell
npm run dev -- --start-url "https://mail.google.com" --user-data-dir "C:\Users\YOUR_USER\AppData\Local\Google\Chrome\User Data" --profile-directory "Profile 1" --browser-channel chrome --task "Process latest 10 emails..."
```

Notes:
- Close regular Chrome/Edge windows before starting if profile lock errors appear.
- `--profile-directory` can be `Default`, `Profile 1`, `Profile 2`, etc.
- If you omit `--browser-channel`, `chrome` is used when `--user-data-dir` is set.

If Google blocks login with "This browser or app may not be secure", use CDP attach mode:

1. Start your regular Chrome profile manually with remote debugging:

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:LOCALAPPDATA\Google\Chrome\User Data" `
  --profile-directory="Profile 1"
```

2. Login manually in that Chrome window (if needed), then run the agent attached to it:

```powershell
npm run dev -- --cdp-url "http://127.0.0.1:9222" --start-url "https://mail.google.com" --task "Process latest 10 emails..."
```

In CDP mode the agent connects to your already opened browser session instead of launching an automation-marked login browser.
When multiple tabs exist, the agent now prefers an already open tab matching the `--start-url` host before navigating.

### CDP Troubleshooting (Chrome Profile)

If you see `ECONNREFUSED 127.0.0.1:9222`, Chrome was not started with remote debugging (or on a different port).

1. Fully close all Chrome windows.
2. Start Chrome with your real profile and debug port:

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:LOCALAPPDATA\Google\Chrome\User Data" `
  --profile-directory="Profile 4"
```

3. Verify endpoint:

```powershell
Invoke-WebRequest "http://127.0.0.1:9222/json/version" | Select-Object -ExpandProperty StatusCode
```

Expected result: `200`.

4. Run the agent with the same port:

```powershell
npm run dev -- --cdp-url "http://127.0.0.1:9222" --start-url "https://mail.google.com" --task "..."
```

Notes:
- `--profile-directory` must match your actual profile folder (`Default`, `Profile 1`, `Profile 2`, etc.).
- Keep `--user-data-dir` as the full path with quotes (path contains spaces).
- If you use another port, pass the same value in both Chrome launch and `--cdp-url`.

In restricted environments where `tsx` cannot spawn worker processes, use compiled mode:

```bash
npm run build
npm run start -- "Open example.com and summarize the homepage"
```

With `AGENT_CDP_URL` set in `.env`, you can simply run:

```bash
npm start
```

Then only enter the task in the prompt.

## Reliable End-to-End Demo Scenario

A local food-ordering demo site is included for repeatable assignment demos.

Run:

```bash
npm run demo:food
```

Non-interactive demo run:

```bash
npm run demo:food -- --auto
```

This starts a local site and runs a recommended task:

- add items to cart
- go through checkout
- reach payment confirmation
- stop before final payment
- produce report

No site-specific hardcoded flow is implemented in the agent logic.

## Demo Recording Tips

For a clean video:

1. Keep terminal and browser visible side-by-side.
2. Use `npm run demo:food`.
3. Show logs with:
   - assistant intent
   - tool name
   - tool args
   - tool result
4. End on final report section.

Session logs are stored in `artifacts/logs/`.
Screenshots (if taken by tool) are in `artifacts/screenshots/`.

## Design Decisions and Trade-offs

1. **Responses API + function tools**
   - Pros: native tool-calling loop.
   - Trade-off: dynamic typing from SDK requires runtime validation (handled by Zod + guards).

2. **Runtime `data-agent-id` tagging**
   - Pros: avoids site-specific selectors and keeps actions model-friendly.
   - Trade-off: IDs can go stale on heavy rerenders; tools recover by refreshing state.

3. **Compact observation over full HTML**
   - Pros: lower token cost, clearer planning signals.
   - Trade-off: some deep DOM details are abstracted away.

4. **Terminal-first UX**
   - Pros: fast MVP and clear logs for assignment review.
   - Trade-off: no rich chat UI yet.

5. **Local demo site**
   - Pros: deterministic demo reliability.
   - Trade-off: does not prove coverage of every external modern web app edge case.

## Why This Avoids Hardcoded Flows

- No predefined selectors for specific domains.
- No URL-path assumptions.
- No site-specific scripts in agent logic.
- Decisions are made from current extracted state + tool outputs at runtime.

## Known Limitations

- Single-tab, single-page context management.
- No long-term memory persistence across sessions.
- CAPTCHA/login handling requires user help (by design).
- Complex SPA rerenders can invalidate IDs more frequently.
- LLM quality and API latency affect success rate.
- No automatic retry policy per tool beyond local validation/re-observation.

## Build / Typecheck

```bash
npm run typecheck
npm run build
```

## Project Structure

```text
src/
  agent/
  browser/
  cli/
  demo/
  observation/
  tools/
  types/
```
