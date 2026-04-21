# AGENTS.md

## Mission

Build a working prototype of an autonomous browser agent for a test assignment.

The agent must:
- open and control a real browser in headed mode
- accept a natural-language task from the user via terminal or separate chat UI
- solve multi-step browser tasks autonomously
- show visible progress in the browser
- log tool calls and arguments in a readable form
- stop only when the task is complete, blocked, or requires user input
- provide a short final report

The goal is not to hardcode one demo, but to build a small general-purpose browser agent architecture.

---

## Assignment requirements

The implementation must satisfy these constraints:

### Required behavior
- The user sends a free-form task in natural language.
- The agent explores the page and decides what to do next at runtime.
- The browser remains visible while the agent works.
- The user can observe the agent's actions and tool calls.
- The agent works autonomously until:
  - the task is completed
  - additional user information is required
  - the agent is blocked

### Example tasks the system should be able to support
- delete spam from recent emails
- order food and stop before final payment
- find relevant vacancies and draft personalized responses

These are examples only. Do not build fixed scripts for them.

---

## Hard constraints

Do NOT implement any of the following:

- no hardcoded action flows for specific tasks
- no predefined selectors for specific sites
- no hardcoded route knowledge such as `/vacancies`
- no assumptions like “to add to cart click a button with text X”
- no site-specific procedural templates disguised as general logic

The agent must infer what to do from the current page state.

---

## Engineering direction

Prefer the following stack unless there is a strong reason to change it:

- TypeScript
- Node.js
- Playwright
- OpenAI-compatible tool-calling agent loop
- terminal-first UX

Use a hybrid page-understanding strategy:
- structured runtime extraction from DOM / accessibility-relevant data
- screenshots for validation and recovery
- compact observations instead of dumping full HTML into the model

The system should be designed around a tool-calling loop, not around a fixed script.

---

## Architecture target

Implement the project with clear separation of concerns.

Suggested modules:
- `src/agent/` — agent loop, planning, memory, prompts
- `src/browser/` — Playwright lifecycle and browser control
- `src/tools/` — tool implementations
- `src/observation/` — page summarization, element extraction, selector/id generation
- `src/cli/` — terminal chat / session runner
- `src/types/` — shared types
- `src/demo/` — optional demo runner or example tasks

The code should be understandable and easy to demo.

---

## Core runtime model

The agent should operate in a loop:

1. receive user goal
2. inspect current state
3. decide next tool call
4. execute one meaningful action
5. observe result
6. repeat until done / blocked / needs user input

Maintain explicit task state:
- user goal
- known facts
- completed actions
- current page summary
- unresolved questions
- latest observation

Do not rely on hidden implicit state where avoidable.

---

## Tools to implement

Implement a compact, useful set of tools. Favor quality over quantity.

Expected tool set:
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

You may add small helper tools if justified.

### Tool design rules
- Tools must return structured observations.
- Observations must be concise and useful for the next decision.
- Avoid returning raw full-page HTML unless debugging.
- Prefer stable runtime-generated element IDs over exposing brittle selectors directly.
- If selectors are needed internally, generate them dynamically at runtime.

---

## Page understanding requirements

Implement a page-state representation that helps the model reason.

`get_page_state` should aim to return:
- current URL
- page title
- visible interactive elements
- important text blocks
- form inputs
- modal / overlay presence
- lightweight page summary

Each visible interactive element should ideally include:
- `elementId`
- tag / role
- accessible name or text
- short description
- visible/enabled flags
- optional selector metadata for execution layer only

`query_dom` should support focused questions such as:
- whether a delivery address chooser is present
- whether a cart button exists
- what products are shown
- what validation errors are visible
- whether a success state appeared after an action

This tool is important. It should help the agent inspect the page instead of blindly clicking.

---

## UX requirements

The demo must look good in a video.

Target demo layout:
- browser visible on screen
- terminal or chat visible on screen
- readable logs of tool calls and arguments
- visible progress while the browser changes
- short final report

The output should resemble:
- assistant intent
- tool name
- tool input
- tool result
- final summary

Prefer clarity over flashy UI.

---

## Safety rules

The agent must pause and ask for user input when:
- login is required
- 2FA / captcha appears
- payment confirmation is reached
- an irreversible destructive action is ambiguous
- multiple plausible interpretations remain and the wrong choice would matter

For purchase flows, reaching checkout is fine. Do not finalize payment automatically.

---

## First implementation milestone

Your first goal is to produce a working MVP that can be demonstrated end-to-end.

MVP definition:
- headed browser launches successfully
- terminal accepts a natural-language task
- agent loop runs with tool calls
- page understanding works on modern web apps
- at least one complex scenario works in a visible demo
- final report is produced

Prioritize one reliable demo scenario:
- food ordering is preferred
- stopping before payment is acceptable and desirable

---

## Delivery expectations

Create:
1. working code
2. clear README
3. environment setup instructions
4. `.env.example`
5. a short section explaining architecture and trade-offs
6. demo instructions
7. a note on limitations

If useful, add:
- action logs
- screenshots in `artifacts/`
- a demo script or sample prompt

---

## README requirements

README must explain:
- what the project does
- why this architecture was chosen
- how the agent loop works
- how page understanding works
- why the solution avoids hardcoded selectors and fixed flows
- how to run the project
- how to record the demo
- known limitations

Also include a short “design decisions” section with explicit trade-offs.

---

## Working style

Work incrementally.
After each meaningful milestone:
- keep the project runnable
- update docs if needed
- avoid large unstructured rewrites
- prefer small verifiable steps

When uncertain, choose the most general solution that still keeps the MVP achievable.

Do not stall in planning for too long. Start building quickly.

---

## Immediate next steps

Execute the following plan now:

1. inspect repository state
2. scaffold the project if needed
3. set up TypeScript + Node + Playwright
4. create the agent loop skeleton
5. implement browser manager
6. implement the first tool set
7. implement page-state extraction
8. implement terminal interaction
9. wire the model to tools
10. make one scenario demonstrably work
11. improve logs for demo quality
12. finalize README and usage instructions

Start with a pragmatic MVP, then harden it.

---

## Quality bar

A good result is:
- not a toy one-off script
- not a hardcoded site bot
- not a vague framework with no demo
- a real small agent system that visibly works

Optimize for:
- autonomy
- observability
- generality
- demo reliability
- implementation clarity