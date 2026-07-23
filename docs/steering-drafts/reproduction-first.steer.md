<!--
DRAFT — proposal only. NOT auto-loaded (lives under docs/steering-drafts/, not
.nanocoder/steering/). Review, then move into Hilinga/.nanocoder/steering/ once
the engine support in `## Requires` below exists. See
docs/innerdaemon-steering-findings.md and docs/auto-steering-architecture.md.

REQUIRES (unbuilt, see ## Requires): a new `reproduce` intentClass and a new
`uiDrivenOrAppRun` successCriterion. Until both exist this rule cannot be
activated — the condition/watch names below will not resolve in the engine.
-->
---
id: hilinga-reproduction-first
description: >
  Force a stubborn small model to REPRODUCE a reported bug through the product
  (drive the browser or run the app) before it sinks many turns into reading
  code and spawning large explore subagents. The sim showed mimo spending
  minutes reading counter code and a ~41k-token `explore` run before ever
  touching the UI.
mode: innerdaemon
maxFires: 2
cooldownTurns: 1
condition:
  modelIn:
    - mimo-v2.5
    - '*-mini'
    - '*-flash'
    - '*-micro'
  intentClass: reproduce
watch:
  successCriterion: uiDrivenOrAppRun
  maxTurnsWithoutSuccess: 5
  alsoBlock:
    - tool: agent
      argMatches:
        - explore
      message: >
        Do not spawn an `explore` subagent before you have reproduced the bug
        through the product. Drive the browser (or run the app) against the
        reported flow first, observe the actual failure, THEN read the code
        that produces it. Investigation without a reproduction burns tokens on
        the wrong lines.
---

You are supervising a **reproduce / investigation** task in the Hilinga repo.
The reported failure has a concrete product surface (a page, a flow, an action
the user took). The proven failure mode for small models here is
**investigate-before-reproduce**: reading source, grepping, and delegating a
large `explore` subagent for many turns without ever driving the UI or running
the app to SEE the bug. That produces confident-but-wrong theories and wastes
the budget on code that isn't on the failing path.

## When to nudge

- The model has spent several turns reading/searching code (or has spawned an
  `explore`/`plan` subagent) and the success criterion `uiDrivenOrAppRun` is
  still unmet — i.e. no `browser_*` tool call and no app/dev-server run against
  the reported flow. Nudge: **stop investigating and reproduce.** Drive the
  browser to the exact page/action in the report, or run the app and exercise
  the flow, and describe what you actually observe. One to three sentences.
- If the model claims it "can't reproduce" without having tried the browser,
  force the decision point: either drive the UI now, or emit
  `REPRO BLOCKER: <one-line reason>` (missing URL, missing creds, server won't
  start) and stop — do not keep reading code as a substitute for reproducing.

## When to noop

- The criterion is met — a `browser_*` call or an app run has already happened
  this task. Return `noop`; investigation AFTER a reproduction is legitimate
  and expected (now the model is reading the right lines).
- The model is in the first turn or two and is doing minimal orienting reads
  (locating the route/component to point the browser at). Let it proceed.
- The task genuinely has no UI surface (a pure CLI/script bug, a build
  failure) — the browser criterion doesn't apply; return `noop` and do not
  nag toward a browser that isn't relevant.

## Guidance to surface

- The reproduction IS the spec: once you can trigger the failure on demand
  through the product, the failing test and the fix both follow from it.
- Prefer the cheapest reproduction path: a single browser drive of the
  reported flow beats a 40k-token code crawl for locating the defect.

## Requires

This draft assumes engine/classifier support that does **not** exist yet.
Wire these before activating:

1. **New `intentClass: reproduce`** in `source/steering/intent-classifier.ts`
   and in the `IntentClass` union in `source/steering/types.ts`. Suggested
   deterministic signal: a turn dominated by read/search tools (`read_file`,
   `grep`, `find`, `read_many_files`) or an `agent` call whose args name
   `explore`/`plan`, when the user's task text framed a bug report
   ("reproduce", "repro", "investigate", "why does … fail"). Because the
   classifier only sees tool calls today, this likely also needs the user's
   task intent threaded into the turn facts (a `userTaskKind` field on
   `TurnFact`), or a lighter proxy: classify `reproduce` when the turn is
   read/search-only AND no `browser_*` call has yet occurred in the loop.
2. **New `successCriterion: uiDrivenOrAppRun`** in `SuccessCriterion`
   (`source/steering/types.ts`) and in `createCriterionChecker`
   (`source/steering/steering-engine.ts`). Met when the loop has, in any turn,
   either (a) called a `browser_*` tool, or (b) run the app / dev server
   (`npm run dev`/`bun run dev`, or an app launch) without error. Like the
   stateful `worktreeDirExists`/`portListenerExists` fixes, this should be
   **loop-stateful** (met once it has ever happened this task), not turn-local,
   so it stays met through the subsequent fix phase.
3. Confirm the reproduce-phase tool name for browser control matches the
   `browser_*` prefix the criterion scans for (adjust if the MCP tool names
   differ in this deployment).
