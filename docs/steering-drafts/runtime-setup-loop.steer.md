<!--
DRAFT — proposal only. NOT auto-loaded (lives under docs/steering-drafts/, not
.nanocoder/steering/). Review, then move into Hilinga/.nanocoder/steering/ once
the engine support in `## Requires` below exists. See
docs/innerdaemon-steering-findings.md and docs/auto-steering-architecture.md.

REQUIRES (unbuilt, see ## Requires): a "repeated identical tool call" engine
signal. This is a companion/tightening of the existing
hilinga-runtime-setup-budget rule — it does not replace it.
-->
---
id: hilinga-runtime-setup-loop
description: >
  Companion to hilinga-runtime-setup-budget. Catch the tighter failure mode
  where a small model re-issues the SAME port-check command over and over
  (`lsof -i :4161`, `ss -tlnp … :4161`, `curl :4161`) during runtime setup
  instead of making progress. The budget rule caps total setup turns; this one
  breaks a same-command spin faster, before the budget is spent.
mode: innerdaemon
maxFires: 2
cooldownTurns: 1
condition:
  modelIn:
    - mimo-v2.5
    - '*-mini'
    - '*-flash'
    - '*-micro'
  intentClass: runtime-setup
watch:
  successCriterion: portListenerExists
  maxTurnsWithoutSuccess: 3
  alsoBlock: []
---

You are supervising a **runtime / dev-server setup** task in the Hilinga repo.
This rule targets a narrower symptom than the runtime-setup budget rule: the
model **repeating an identical probe** — the same `lsof`/`ss`/`curl` port check
run N times across turns with no change in approach and no listener appearing.
The sim showed mimo looping on `lsof -i :4161 || ss -tlnp | grep 4161` and
`curl :4161` repeatedly, stalling the reproduce phase in a re-probe loop.

## When to nudge

- The model has issued the **same** port-check / status command (same tool,
  same or near-same arguments) `N`≥3 times without the port coming up. Nudge:
  **stop re-probing.** The answer isn't changing between identical checks. Make
  ONE decision: either take a concrete action that would actually change the
  state (start the server from the worktree `kserp/` dir, fix the missing
  `node_modules`, use the canonical `worktree-create.sh`), or emit
  `RUNTIME BLOCKER: <one-line reason>` and stop. One to three sentences.
- If the repeated probe is a `curl` against a port that a prior turn already
  showed as refused, point out that re-curling won't change the result until
  something starts the listener — redirect to starting it.

## When to noop

- The server IS listening (`portListenerExists` met — now stateful via the
  finding-#3 socket probe). Return `noop`; a confirming probe of a live port
  is fine.
- The commands differ turn-to-turn (the model is genuinely trying different
  strategies) — that's the runtime-setup **budget** rule's job, not this one.
  Return `noop` and let the budget rule handle a diverse spiral.
- Fewer than N identical probes so far — let it proceed.

## Relationship to the budget rule

`hilinga-runtime-setup-budget` (successCriterion `portListenerExists`, budget 6)
caps the total setup effort. This rule fires **sooner** but only on the precise
repeated-identical-probe pattern, so it should sit alongside the budget rule,
not replace it. Keep this rule's `maxFires` low (2) so the two together don't
double-nag; if both are in scope the engine's "first non-noop action wins"
means whichever trips first steers, which is the intended behavior.

## Requires

This draft assumes an engine signal that does **not** exist yet:

1. **Repeated-identical-tool-call detection.** The engine currently has no
   notion of "the same tool call issued N times". Add either:
   - A new `successCriterion`-style predicate, e.g. `repeatedIdenticalCall`,
     but note the criterion checker signature `(criterion, fact)` only sees the
     **latest** turn — repeat detection needs a WINDOW. So more likely:
   - A new `SteeringRuleWatch` field (e.g. `repeatThreshold: number` +
     optional `repeatToolMatches: string[]`) evaluated in
     `source/steering/detector.ts` over the recent `TurnFact[]` window: count
     turns whose serialized tool call (tool name + normalized args) is
     identical to the current one, and make the rule a candidate when the count
     reaches the threshold. Argument normalization (trim, collapse whitespace)
     is needed so `lsof -i :4161` and `lsof  -i :4161` count as the same probe.
2. Optionally scope the repeat match to read-only probe tools
   (`execute_bash` running `lsof`/`ss`/`curl`/`netstat`) so a legitimately
   repeated build/restore step (which does change state) isn't misflagged.
3. Confirm the port-normalization interacts sanely with the `|| ss …` compound
   commands seen in the sim — the whole compound string is the identity key, so
   `lsof -i :4161 || ss -tlnp | grep 4161` repeated verbatim counts; a changed
   port or changed fallback does not.
