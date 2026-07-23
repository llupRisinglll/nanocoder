# Auto-Steering & InnerDaemon — Architecture for nanocoder

Status: **Design proposal** (not yet implemented)
Date: 2026-07-22 (rev 2)
Owner: llupRisinglll/omnicode (fork)

> **Rev 2 changes** from the first draft: the secondary thinker is now a named, first-class component (**InnerDaemon**) with its own model and its own context — not just a deterministic rule engine. The mechanism is reframed as a **unified hook + skill + thinking** layer: a deterministic **Detector** (always-on, cheap, like skill matching) gates **InnerDaemon** (the LLM secondary thinker), which decides whether and how to steer. The key payoff: dense, routinely-ignored skill prose moves *out* of the always-loaded main context and *into* InnerDaemon's on-demand context — saving main-agent context.

## TL;DR

nanocoder's passive instruction layer (skills, commands, AGENTS.md) tells the model what good looks like, but stubborn/small models ignore it. The Hilinga simulation proved this three times: the `worktree.md` command body literally says *"Use the scripts. Do not hand-roll"* and mimo hand-rolled for 5+ minutes anyway; *"report the blocker and stop"* was ignored across six runtime-recovery strategies.

The proposal adds an **active steering layer** with two stages:

1. **Detector** — always-on, deterministic, cheap. Matches the current turn against steering rules the same way skills are matched. Runs every turn, never calls an LLM. Its only job is to decide *whether InnerDaemon needs to run*.
2. **InnerDaemon** — the secondary thinker. Its own model, its own context. Spins up **only when the Detector finds a candidate match** (so it is not always active and cannot overload the session). Reads the recent turn history, decides whether the model is genuinely off-track, and emits a steering instruction that is injected into the main agent's next turn — rendered subtly as **"InnerDaemon" light details** in the TUI.

This unifies the three behaviors in the title:

| Existing concept | Steering-layer analogue | Why |
|---|---|---|
| **Hook** (event → action) | Detector turn-match → InnerDaemon activation; InnerDaemon decision → injected/blocking action | Enforcement, not advice |
| **Skill** (condition → instructions) | Rule condition ("frontend edited", "worktree skill triggered", "model is mimo") | Cheap gating, only fires when relevant |
| **Thinking** (secondary reasoning) | InnerDaemon's own model+context reasoning over the situation | Decides *whether* and *what* to steer when a deterministic rule can't |

And because InnerDaemon carries its own context, the dense procedural prose that always gets ignored anyway can migrate **out** of the always-loaded worktree skill and **into** InnerDaemon's on-demand context — shrinking the main agent's always-on context while keeping the knowledge available exactly when needed.

---

## 1. What the simulation proved (problem statement)

See `docs/hilinga-nanocoder-observations.md` for full detail. The load-bearing facts:

- **Passive instructions are ignored by stubborn models.** The worktree command body explicitly forbids hand-rolling; mimo hand-rolled. The prompt said "report and stop"; mimo chained six strategies for 15 minutes.
- **The model is capable of the right move when forced.** A single focused, condition-triggered nudge ("decide or report, do not try another strategy") broke a 15-minute stall in ~90 seconds. The gap is a missing *trigger*, not missing knowledge and not missing capability.
- **Existing loop detection is too narrow.** `MAX_REPEATED_TOOL_CALLS` only fires on *identical* tool signatures. mimo's spiral used *varied* commands (DB → symlink → copy → hardlink) pursuing one goal, so the detector never fired.
- **Some detection needs an LLM, some doesn't.** "Did the model emit `git log`?" is a substring check (no LLM). "Is the model *semantically* stuck on runtime setup despite varied commands?" needs judgment (LLM). One pure-detector engine can't cover both.

---

## 2. The two-stage pipeline

```
 every turn boundary (conversation-loop.tsx recursion)
            │
            ▼
 ┌──────────────────────────────────────────┐
 │  DETECTOR  (deterministic, always-on)     │   no LLM. cheap.
 │  - matches turn facts vs steering rules   │   like skill matching.
 │  - intent class, model id, tool substrings │
 │  - file-watch signals (e.g. frontend      │
 │    edited, worktree dir appeared)         │
 └──────────────────────────────────────────┘
       │ no candidate match → no-op (loop recurses normally)
       │ candidate match(es) ──┐
                            ▼
 ┌──────────────────────────────────────────┐
 │  INNERDAEMON  (secondary thinker, on-demand)│   own model + own context.
 │  - spun up ONLY on a detector candidate   │   not always active.
 │  - reads recent turn history + rule body  │
 │  - decides: off-track? what nudge?        │
 │  - returns SteeringAction or NO-OP        │
 └──────────────────────────────────────────┘
       │ NO-OP → loop recurses normally
       │ action ──┐
                ▼
 ┌──────────────────────────────────────────┐
 │  APPLY  (into the main agent's next turn) │
 │  - inject(message) → MessageBuilder       │   rendered as InnerDaemon
 │  - block(tool,args) → cancellation result │   "light details"
 │  - stop(reason)     → end loop            │
 └──────────────────────────────────────────┘
```

### 2.1 Why two stages (detector + LLM)

The detector is cheap and runs every turn, so it can afford to be broad (cast a wide net on "this *might* be a steering situation"). InnerDaemon is expensive (an LLM call with its own context), so it must run rarely — only when the detector says a candidate exists. This is the "activate only when frontend is edited" / "not always active" / "don't overload it" requirement: **the detector is the gate that keeps InnerDaemon off most of the time.**

This mirrors the existing skill architecture exactly: the `skill` tool's description tells the model "use this when the user task matches a skill" — a cheap match that gates loading the full (expensive) skill body. The detector is the deterministic, always-on version of that gate.

### 2.2 When InnerDaemon runs vs when the detector alone suffices

- **Detector-only** (no InnerDaemon call): hard constraint violations. "Model emitted `git log` in a no-history simulation" → block + message, no judgment needed. Cheap, deterministic, always safe.
- **InnerDaemon** (LLM): semantic judgment. "Is mimo *semantically* stuck on runtime setup?" / "did the worktree actually get created successfully?" / "is this frontend edit the kind that needs the design-system reminder?" These need reasoning over context; a regex can't decide them.

A rule declares which path it uses (`mode: detector-only` vs `mode: innerdaemon`).

---

## 3. InnerDaemon — the secondary thinker

### 3.1 It is a specialized subagent

nanocoder already has the pattern: `SubagentExecutor` (`source/subagents/subagent-executor.ts`) spawns a secondary model with its **own system prompt, own message history, filtered tools, and an isolated context**. InnerDaemon is a specialized, built-in subagent:

```ts
const INNERDAEMON_CONFIG = {
  name: 'innerdaemon',
  systemPrompt: INNERDAEMON_SYSTEM_PROMPT,   // steering-specific (below)
  tools: ['execute_bash', 'read_file', 'list_directory', 'find_files',
          'search_file_contents'],          // READ-ONLY. never write/edit/bash-mutate.
  disallowedTools: ['edit', 'write', 'agent'],  // cannot steer by acting itself
  // model chosen per session: small/fast for latency, or inherit
};
```

**Read-only tools.** InnerDaemon observes and advises; it never edits code, runs mutations, or spawns further agents. Its only output is a `SteeringAction` (inject / block / stop / no-op) handed back to the main loop. This keeps the steering layer non-destructive: the main agent remains the sole author of changes.

### 3.2 Its own context = the context-savings mechanism

This is the payoff you identified. Today, the worktree skill/command carries dense procedural prose:

> *"Use the scripts. Do not hand-roll the steps… Do NOT investigate the purpose… Do NOT ask the user for details… Then stop — /worktree prepares the worktree, nothing more…"*

mimo ignores it, but it still occupies main-agent context every turn. With InnerDaemon, that prose migrates **into InnerDaemon's system prompt / rule body**, loaded only when the detector fires for a worktree-class situation. The main-agent skill shrinks to a one-liner ("worktree setup is supervised by InnerDaemon; if it asks, follow it"), and the dense rules live where they're actually consulted.

**Net effect:** main-agent always-on context shrinks; the dense knowledge is available on demand via InnerDaemon, which has its own context budget and doesn't pollute the main thread.

### 3.3 What InnerDaemon receives and returns

```ts
// Input to InnerDaemon (built by the detector + engine at fire time):
interface InnerDaemonRequest {
  ruleId: string;
  ruleBody: string;            // the migrated dense prose (e.g. worktree rules)
  situation: {
    modelId: string;           // 'mimo-v2.5'
    intentClass: string;       // 'worktree-creation' | 'runtime-setup' | ...
    recentTurns: TurnFact[];   // compact recent history (last N turns)
    triggerReason: string;     // why the detector fired (human-readable)
    successCriterion: string;  // e.g. "worktree dir exists + plugins loaded"
    observableState?: object;  // e.g. { worktreeDirExists: false, listeners: [] }
  };
}

// Output from InnerDaemon (strict schema):
type InnerDaemonResponse =
  | { action: 'noop'; reason: string }                          // false alarm
  | { action: 'inject'; message: string; urgency: 'light'|'firm' }
  | { action: 'block';  toolRef?: string; message: string }
  | { action: 'stop';   reason: string };
```

InnerDaemon's system prompt forces this schema and instructs it to prefer `noop` when the model is actually fine (avoid nagging).

### 3.4 Rendering: "InnerDaemon (light details)"

When InnerDaemon returns an `inject`, the message renders subtly in the TUI — the visual analog of `AssistantReasoning` (which renders in single-color `colors.secondary` grey, deliberately subdued). Concretely, a new component **`InnerDaemonDetails`** renders the nudge as a one-line grey prefix (`◆ InnerDaemon`) plus the short message, collapsed by default, expandable with the same ctrl-r affordance reasoning uses. It is *not* a loud `ErrorMessage` box — that visual is reserved for hard `stop` actions only.

The `urgency` field lets InnerDaemon escalate visual weight: `light` (grey, the default nudge) vs `firm` (still inline but accented) before any `stop`.

---

## 4. Rules: hook + skill + thinking as data

Rules live in `.claude/steering/*.steer.md` (frontmatter + optional body), mirroring the skills/commands pattern and keeping Hilinga-specific steering in the Hilinga repo.

### 4.1 Frontmatter (the hook + skill parts)

```yaml
---
id: hilinga-worktree-supervision
description: Supervise worktree creation so the verified scripts are used and the task stops after setup.
# --- the SKILL part: when does this rule's situation exist? ---
condition:
  anyOf:
    - modelIn: ['mimo-v2.5', '*-mini', '*-flash']      # stubborn models
      andIntentClass: 'worktree-creation'              # /worktree typed or worktree skill active
    - userTriggeredSkill: 'worktree'                   # user ran /worktree
# --- the HOOK part: what does the detector watch for? ---
watch:
  successCriterion: worktreeDirExists                   # observable end-state
  maxTurnsWithoutSuccess: 4                             # budget before InnerDaemon
  alsoBlock:                                            # hard constraints (detector-only)
    - { tool: execute_bash, argMatches: ['git log', 'git show', 'git blame', 'git reflog'],
        message: 'git-history is forbidden in this simulation.' }
mode: innerdaemon            # 'innerdaemon' (LLM) or 'detector-only'
maxFires: 3                # after 3 InnerDaemon injections with no progress → stop
---
```

### 4.2 Body (the THINKING context — the migrated dense prose)

```markdown
You are supervising a worktree-creation task. The verified scripts are:
- worktree-create.sh <name> [base]
- worktree-remove.sh <name> [--keep-db]

Rules the main agent must follow (it has likely ignored these in its skill —
your job is to re-surface them at the moment they're being violated):
- Use the scripts. Do not hand-roll git worktree add / mkdir / symlink steps.
- Do not investigate the purpose of the worktree.
- After the worktree exists and plugins are wired, STOP. Hand back.

Decide whether the agent is off-track and emit the smallest nudge that
re-routes it. Prefer noop if it's already correcting.
```

This body is InnerDaemon's domain context — loaded into InnerDaemon's context only when this rule fires, never into the main agent's always-on context.

### 4.3 Condition matching (the detector's job, every turn)

The detector evaluates `condition` against per-turn facts:

- `modelIn` / `modelNotIn` — flag by model ("only when mimo"). Satisfies the core requirement: steering is inert for well-behaved models.
- `intentClass` — from a cheap keyword classifier over tool calls (e.g. `execute_bash` + `worktree|git worktree` → `worktree-creation`).
- `userTriggeredSkill` — set when the user typed the slash command or invoked the skill (tracked by the existing command-integration path).
- `fileEdited` / `pathMatches` — "activate only when frontend is edited" (`condition.pathMatches: 'ui/**'`).
- `cwdIn` — worktree vs main checkout.

A rule with no `condition` is always a candidate (applies to all models/situations) — the "cases we need to apply to all."

### 4.4 File watchers as a detector source

You raised that some conditions are best solved by a **script watcher**. The detector accepts signals from file-system / process watchers in addition to per-turn facts:

- `worktreeDirExists` — watched by the existing file-change event system (`source/events/`, `EventKind: 'file.changed'`) or a lightweight `fs.exists` check at the turn boundary.
- `portListenerExists` — a one-line `ss`/socket check for runtime-setup rules.
- `frontendEdited` — a path-matched file-change event.

These are cheap, observable, deterministic — exactly the signals a detector should consume without an LLM.

---

## 5. Your stated case, end-to-end

> *"the condition is model has to be mimo, and the model will need to use the worktree script or the user triggered the worktree skill. We need to watch until it successfully created the worktree."*

With the rule in §4.1–4.2, this flows:

1. **Turn 1:** user types `/worktree nanocoder-counter-auto-settle`. Command-integration sets `userTriggeredSkill: 'worktree'`. Detector: `modelIn mimo` ✓ AND `userTriggeredSkill worktree` ✓ → candidate match. InnerDaemon spins up, sees the agent is just starting, returns `noop`.
2. **Turns 2–4:** agent begins hand-rolling (`git worktree add`, mkdir, reading `.gitopolis.toml`). Detector tracks `intentClass: worktree-creation` turns; `worktreeDirExists` is still false. No `git log` yet, so no hard block.
3. **Turn 5 (budget hit, `maxTurnsWithoutSuccess: 4`):** Detector fires InnerDaemon with `triggerReason: "5 turns in worktree-creation, worktreeDirExists=false"`. InnerDaemon reads the dense rule body (the migrated prose), sees hand-rolling, returns `inject` with the nudge: *"You're hand-rolling a worktree. /worktree runs the verified scripts — invoke it, or report why you can't. Don't run another manual step."* → rendered as **InnerDaemon light detail**.
4. **If the agent also emits `git log`:** the `alsoBlock` detector-only rule fires instantly (no InnerDaemon call) → block + the no-history message.
5. **Success:** once the watcher reports `worktreeDirExists: true` and plugins are wired, the detector stops firing for this rule. InnerDaemon returns `noop` if called.
6. **Max fires exceeded:** after 3 InnerDaemon nudges with no success, engine escalates to `stop` (loud error) — the enforcement of "report and stop" that prose couldn't enforce.

---

## 6. Why this satisfies every requirement you stated

| Your requirement | How the design meets it |
|---|---|
| "inject message should appear as InnerDaemon (light details)" | `InnerDaemonDetails` component, grey `colors.secondary` treatment like `AssistantReasoning`, collapsed-by-default with ctrl-r expand. Loud box reserved for `stop` only. |
| "sometimes solvable by script watcher, sometimes need LLM" | Two-stage: detector consumes file/process watchers (no LLM); InnerDaemon is the LLM fallback for semantic judgment. Rule declares `mode`. |
| "secondary thinking, but not always active / not overloaded" | Detector gates InnerDaemon. InnerDaemon runs only on a candidate match. Broad detector, rare LLM. |
| "condition like 'activate only when frontend edited' — need a detector to find possible condition matches like skills" | `condition.anyOf` with `pathMatches`, `intentClass`, `modelIn`, `userTriggeredSkill` — deterministic matching every turn, exactly analogous to skill matching. |
| "combined hook + skill + thinking" | §4 table: hook=enforcement action, skill=condition gate, thinking=InnerDaemon. One mechanism. |
| "condition: model is mimo AND uses worktree script / user triggered worktree skill; watch until worktree successfully created" | §5 end-to-end walk-through. `modelIn` + `userTriggeredSkill` + `watch.successCriterion: worktreeDirExists`. |
| "reduce info in worktree skill since it gets ignored — InnerDaemon has its own context, saves main-agent context" | §3.2: dense prose migrates from the always-loaded skill into InnerDaemon's on-demand rule body. Main skill shrinks to a pointer. |

---

## 7. Integration seams (verified against the actual code)

| Component | File | Role |
|---|---|---|
| Turn-boundary recursion (injection point) | `source/hooks/chat-handler/conversation/conversation-loop.tsx` (~line 996–1017) | Where `MessageBuilder.addToolResults` + `addMessage` happens before recurse. Steering injects here, beside the existing `buildAutoDiagnosticsMessage` precedent. |
| Existing loop detector (to generalize) | same file (~line 760–786), `MAX_REPEATED_TOOL_CALLS` | The detector extends this from "identical signature" to "intent-class budget + watchers". |
| Secondary thinker with own context | `source/subagents/subagent-executor.ts` (`SubagentExecutor`, `createSubagentContext`) | InnerDaemon is a built-in read-only subagent built on this. |
| Light-detail rendering analog | `source/components/assistant-reasoning.tsx` (single-color `colors.secondary`) | Visual template for `InnerDaemonDetails`. |
| Skill matching analog | `source/tools/skill.tsx`, `source/skills/skill-registry.ts` | Detector mirrors the cheap-match-gates-expensive-load pattern. |
| File/process watchers | `source/events/` (`EventKind: 'file.changed'`) + turn-boundary `fs`/socket checks | Detector signal sources. |
| Rule-file loading | analog of `source/custom-commands/loader.ts` | `.claude/steering/*.steer.md` loader. |

No new event bus, no parallel control flow. The detector+InnerDaemon call is inserted into the existing recursion, exactly where `buildAutoDiagnosticsMessage` already injects.

---

## 8. Hard problems (called out honestly)

1. **Detector false-positive rate vs InnerDaemon cost.** A broad detector that fires often will spin InnerDaemon often (cost/latency). Mitigation: detector returns a *confidence* and a *cooldown*; InnerDaemon only runs when confidence clears a threshold and the rule hasn't fired in N turns. InnerDaemon's first job is to reject false alarms (`noop`), which is cheap relative to a wrong steering action.
2. **InnerDaemon latency on the critical path.** An LLM call at every candidate turn adds latency. Mitigations: (a) detector-only rules for the cheap/deterministic cases (the `git log` block needs no LLM); (b) a fast/small model for InnerDaemon (it does shallow judgment, not deep coding); (c) run InnerDaemon *after* dispatching the turn's tool results, in parallel with the next model call where possible, so the nudge lands on the *following* turn rather than blocking.
3. **Avoiding nag loops.** `maxFires` + `cooldownTurns` per rule; after exhaustion, escalate `inject → stop`. InnerDaemon is explicitly instructed to prefer `noop`.
4. **InnerDaemon prompt drift.** The secondary thinker is itself an LLM and can be wrong. Hard guardrails: read-only tools (it can't break anything directly), strict output schema, and the main agent is free to ignore a `light` nudge (it's advisory-forcing, not a hard override) — only `block`/`stop` are non-advisory.
5. **Determinism/testing.** The detector is pure (facts + conditions → candidates) and fully unit-testable with synthetic `TurnFact[]`. InnerDaemon is tested via recorded fixtures (seed request → expected response shape), accepting it's non-deterministic by nature.
6. **Model selection for InnerDaemon.** Open question: same provider as the session, a fixed small model, or configurable per rule? v1: inherit session model with a small-model preference; make it configurable in the rule frontmatter (`innerdaemonModel`).

---

## 9. Phased rollout

**Phase 0 — detector-only, one rule, validate the gate.**
Add the detector + the `alsoBlock` constraint rule only (the `git log` / no-history block), gated on `modelIn: ['mimo-v2.5']`. No InnerDaemon yet. This validates the cheapest part (deterministic detection + block) with zero LLM cost and re-uses the existing seam. Re-run the Hilinga simulation.

**Phase 1 — InnerDaemon + the worktree-supervision rule.**
Build InnerDaemon as a read-only built-in subagent. Implement the worktree rule from §4. Migrate the dense prose out of `worktree.md` into the rule body. Add `InnerDaemonDetails` rendering. Re-run the simulation; measure (a) whether mimo self-recovers without manual interrupt, (b) main-agent context-token reduction from the skill slim-down.

**Phase 2 — scenario migration + custom conditions.**
Generalize conditions (`pathMatches` for frontend, etc.). Migrate scenario-specific CLAUDE.md instructions into `.claude/steering/` rules. Measure fire-rate per model and false-positive rate.

**Phase 3 — watcher integration.**
Wire `source/events/` file-change and process/port signals into the detector for `successCriterion` checks, reducing per-turn `fs` polling.

---

## 10. What to build first to validate

The single highest-leverage claim to validate before building the full engine: **does InnerDaemon's forcing nudge recover a stubborn model from a stall, without manual interrupt?**

Minimal proof of Phase 1:
1. A read-only InnerDaemon subagent that takes `{recentTurns, triggerReason, ruleBody}` and returns `{action, message}`.
2. One detector rule: `modelIn mimo` + `intentClass worktree-creation` + `worktreeDirExists false` for ≥4 turns → fire InnerDaemon.
3. Inject InnerDaemon's `message` at the existing recursion seam, rendered via a throwaway grey component.
4. Re-run the Hilinga worktree simulation.

If mimo self-recovers (uses the scripts, or reports a blocker) without the operator hitting Esc, the architecture is validated. The simulation harness in `docs/hilinga-nanocoder-simulation-plan.md` is the test fixture.

---

## References

- Simulation findings: `docs/hilinga-nanocoder-observations.md` (esp. "Run 2 — the skill-vs-steering finding")
- Run detail + steering-recovery data point: `docs/hilinga-nanocoder-simulation-run-2026-07-22.md` (Run 2, Step 2 Steering Recovery)
- Conversation-loop seam: `source/hooks/chat-handler/conversation/conversation-loop.tsx`
- Subagent own-context pattern: `source/subagents/subagent-executor.ts`
- Light-detail rendering analog: `source/components/assistant-reasoning.tsx`
- Skill-matching analog: `source/tools/skill.tsx`
- File-event watcher source: `source/events/`
