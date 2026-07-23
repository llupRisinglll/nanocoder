# Hilinga Nanocoder Improvement Observations

Date: 2026-07-22

## Purpose

Capture only the nanocoder behaviors and tooling gaps that are worth improving through hooks, skills, or repository instructions.

Raw evidence is kept separately:

- `docs/hilinga-nanocoder-clean-run-capture.txt`

The repeatable test design lives in:

- `docs/hilinga-nanocoder-simulation-plan.md`

## Target Scenario

The simulation task is based on a known Hilinga counter-availment bug:

- A counter availment was originally 4 hours.
- The user edited it to 8 hours.
- The amount recalculated correctly.
- The transaction moved out of "Active now" into "Other transactions this day" as if settled.

The goal is to improve nanocoder so it can reproduce, test, fix, and validate this kind of bug without being told the prior fix.

## Improvement Observations

### 1. Worktree base selection can silently invalidate a simulation

Observed behavior:

- When asked to create a worktree for a pre-fix simulation, nanocoder followed the normal freshness workflow instead of preserving the requested local base state.
- It did not clearly separate "ordinary feature work should use latest remote" from "simulation work may require an intentionally stale local base."

Why it matters:

- A simulation that starts from an already-fixed base cannot produce a legitimate failing regression.
- The agent may then drift, invent a different bug, or patch unnecessarily.

Candidate improvement:

- Add an explicit local-base/pre-fix mode to the Hilinga worktree workflow, such as `--local-base staging`, `base=local:staging`, or `--no-fetch`.
- Print the exact base ref and commit used for every repo.
- If the user says "pre-fix", "simulation", or "use local staging", require confirmation before fetching or fast-forwarding.

### 2. Worktree context is not sticky enough after creation

Observed behavior:

- After a worktree was created, nanocoder sometimes continued reading from the main checkout path instead of the generated worktree path.
- It needed manual correction before consistently using the active worktree.

Why it matters:

- Reads from the main checkout can produce misleading evidence.
- Writes or tests in the wrong checkout can make the agent report progress that does not affect the actual task branch.

Candidate improvement:

- Set an explicit active worktree root after `/worktree`, for example `ACTIVE_HILINGA_WORKTREE=/mnt/data/KSProjects/Hilinga/.claude/worktrees/<name>`.
- Add a hook that blocks reads, writes, and tests under `/mnt/data/KSProjects/Hilinga/<repo>` after a task worktree is active, unless the command is explicitly a base-state check.
- Add a skill rule: after worktree creation, all paths must be under the active worktree.

### 3. TDD sequencing is not enforced strongly enough

Observed behavior:

- Nanocoder identified or approached a suitable test file, then kept reading implementation files.
- It ran existing tests and treated passing tests as meaningful bug evidence.
- It sometimes moved toward implementation before proving a red regression.

Why it matters:

- Existing passing tests do not reproduce a bug.
- Without a red test, the agent can patch the wrong behavior or claim success against unrelated coverage.

Candidate improvement:

- Add a TDD guardrail for bug-fix tasks:
  1. Select the test file.
  2. Add the smallest regression.
  3. Run that exact test and observe failure.
  4. Edit production code only after the red test.
  5. Rerun the targeted test.
  6. Broaden validation.
- If the new regression passes before implementation changes, stop and report that the base may already contain the fix.
- After a test target is selected, warn before additional implementation exploration unless the agent explains why the test cannot be written yet.

### 4. Existing-test success can be misinterpreted as reproduction

Observed behavior:

- Nanocoder ran pre-existing tests and described the run as if it helped verify the buggy state.

Why it matters:

- A green existing suite usually means the bug is not covered.
- Treating it as reproduction weakens the TDD loop and can hide missing coverage.

Candidate improvement:

- Add a rule that distinguishes:
  - "Existing tests pass" means current coverage missed the bug.
  - "Bug reproduced" requires UI observation, a failing regression, or a concrete failing command.
- Flag summaries that claim a bug is verified when the only evidence is a passing existing test.

### 5. Scenario drift can happen before evidence exists

Observed behavior:

- The user-visible symptom was "4h edited to 8h moves out of Active now."
- Nanocoder drifted toward a different internal theory before it had a failing test or UI reproduction proving that theory.

Why it matters:

- The agent can optimize for a plausible internal explanation rather than the reported product behavior.
- It can produce tests that validate a guessed mechanism instead of the user's actual bug.

Candidate improvement:

- Preserve the user's observable symptom as the test target until evidence disproves it.
- Require a short evidence statement before changing the scenario being tested.
- For bug reports, make the first regression assert the observable behavior, not a guessed internal mechanism.

### 6. Cross-plugin exploration needs an evidence threshold

Observed behavior:

- Nanocoder crossed from `kplugin_counter` into `kplugin_finance` before completing the promised local regression step.

Why it matters:

- Cross-plugin reads can be legitimate in Hilinga, but they expand the search space quickly.
- They can delay or replace the requested TDD step.

Candidate improvement:

- Allow cross-plugin investigation only after the agent states the dependency reason.
- In TDD mode, prefer local regression first unless the test cannot be expressed without inspecting the other plugin.
- Add a hook warning when a task scoped to one plugin reads another plugin before producing evidence.

### 7. Broad sub-agent exploration can consume large budget without evidence

Observed behavior:

- Nanocoder launched broad exploration that consumed many tool calls and a large amount of context before returning actionable evidence.
- It did not naturally stop to report "no concrete evidence yet" until interrupted.

Why it matters:

- It makes the agent session feel slow and non-deterministic.
- It increases the chance of irrelevant discoveries and scenario drift.

Candidate improvement:

- Give exploratory sub-agents a small evidence budget for bug fixes.
- Require the sub-agent to return one of:
  - a concrete hypothesis with file/test references,
  - a short "no evidence found" summary,
  - a request for a narrower search direction.
- Prefer focused search around reproduction steps, existing tests, and named product areas before launching a broad explorer.

### 8. Tool root and indexing gaps push the agent toward noisy shell search

Observed behavior:

- Nanocoder frequently fell back to shell tools such as `find`, `grep`, `cat`, `sed`, and `wc`.
- Structured file tools rejected absolute worktree paths with errors like:

```text
Invalid path. Path must be relative and within the project directory.
```

Why it matters:

- The agent may be compensating for a project-root mismatch rather than making a deliberate search choice.
- Lack of LSP/index access makes it slower to find symbol definitions, references, and targeted tests.

Candidate improvement:

- After worktree creation, re-root the agent/tool context to the target repo worktree.
- Add an explicit "refresh index/LSP for this path" step.
- Log whether LSP/indexing is active for the current target root.
- Prefer symbol-aware navigation when available; fall back to grep only after scoped symbol search fails.

### 9. Setup output can hide important state when tailed

Observed behavior:

- Nanocoder ran setup with a trailing summary pattern similar to:

```bash
./worktree-create.sh nanocoder-counter-auto-settle 2>&1 | tail -100
```

Why it matters:

- Early output can contain base selection, fetch behavior, warnings, or env setup details.
- Hiding those details makes later debugging harder.

Candidate improvement:

- Do not pipe setup scripts through `tail` unless the full log is saved.
- For Hilinga setup scripts, write a complete log and show a short summary in chat.
- Add a hook warning when setup scripts are piped directly to `tail`, `head`, or `grep` without preserving the full output.

### 10. Runtime recovery does not force the next reproduction action

Observed behavior:

- Nanocoder attempted browser navigation and hit `ERR_CONNECTION_REFUSED`.
- It diagnosed that the dev server was no longer reachable and restarted it durably.
- After restarting, it did not immediately retry the browser reproduction step.

Why it matters:

- Runtime setup becomes an open-ended activity instead of a bounded prerequisite.
- The session can stall before the first real product observation, so TDD never starts from confirmed behavior.

Candidate improvement:

- Add a reproduction recovery loop:
  1. On browser connection failure, check the listener.
  2. If missing, start the server in a durable logged process.
  3. Once listening, immediately retry the same browser navigation.
  4. If retry fails, report the exact blocker and stop.
- Treat "server is listening" as a transition point, not permission for more setup exploration.

### 11. Runtime fallback commands can bypass project scripts

Observed behavior:

- After a dev-server launch failed, nanocoder built an ad hoc fallback command that invoked `concurrently` directly.
- The command failed because `concurrently` was not available on the shell `PATH`.
- Instead of stopping with a concrete setup blocker, it continued into more log/tail diagnostics.

Why it matters:

- Project scripts usually encode the right binary resolution, environment, and startup shape.
- Ad hoc launch commands can introduce new failures that are unrelated to the product bug being reproduced.

Candidate improvement:

- For Hilinga runtime startup, prefer known package scripts or `npx`/package-manager execution.
- If a direct binary fallback is used, verify the binary path first.
- Limit runtime recovery to a fixed number of attempts, then report the blocker and stop.

## Highest-Priority Rules To Promote

1. After creating a Hilinga worktree, all task work must happen inside that worktree.
2. For simulation/debugging tasks, do not use git history to discover prior fixes unless explicitly allowed.
3. For TDD bug fixes, a failing regression must run before production code is edited.
4. If a requested failing regression passes, stop and report that the base may already contain the fix.
5. Worktree setup must support a local-base/pre-fix mode and print the exact base commit.
6. Cross-plugin investigation needs a stated reason and should not preempt the promised regression test.
7. Exploratory sub-agents need a budget and must report evidence, not just consume context.
8. After recovering a failed browser/runtime setup, immediately retry reproduction or report a concrete blocker.
9. Runtime startup should prefer project scripts and stop after bounded recovery attempts.

## Run 2 (2026-07-22) — the skill-vs-steering finding

Run 2 reproduced the worktree and runtime-setup failure modes of Run 1 with the same model (mimo-v2.5) and confirmed them. The decisive new data point was a **steering-recovery test**:

- After a ~15-minute runtime-setup spiral (the agent chaining DB-restore → plugin-node_modules → symlink → copy → hardlink strategies, ignoring an explicit "report the blocker and stop" instruction), a single focused steering message was injected.
- That message imposed a hard boundary ("make ONE decision in the next 2 tool calls: get a listener up, OR report RUNTIME BLOCKER and stop") and offered two concrete escape hatches.
- **The model converged within ~90 seconds**, pivoted to the correct escape (start the main checkout's already-wired dev server), verified the pre-fix commit was still in place, started the server, and navigated Playwright to the login page — the furthest any run reached.

### What this isolates for the architecture

- The worktree skill already exists, yet the agent improvised manual creation (~30 commands, stripped the name prefix, used borderline-prohibited `git log -1`) and could not self-terminate its setup spiral. **A passive skill file (context loaded, behavior hoped for) did not produce compliance.**
- The steering nudge (an injected, condition-triggered instruction with a hard decision boundary) did produce compliance — instantly.
- The nudge did **not** need to contain the solution. It needed to force a decision point. The model is capable of the right move; it lacked the trigger to make itself stop iterating and decide.
- Therefore the highest-leverage steering primitive is not "tell the model what to do" but **"detect that the model is stuck in an unproductive loop and force it to converge or stop."**

### Additional Run 2 observations (confirming + new)

- **Worktree base selection improved over Run 1.** With an explicit local-base/no-fetch instruction naming the exact pre-fix commit, the agent honored it without correction (verified `kplugin_counter` worktree HEAD = `255c4f0`, no fetch). But it still improvised manual creation rather than dispatching the `/worktree` skill, and stripped the `nanocoder-` name prefix.
- **Manual worktrees are structurally incomplete for runtime.** The canonical `worktree-create.sh` wires plugin `node_modules` via a symlink-farm and always fetches from `origin/staging`. Because the simulation forbade fetch (origin has the fix), the agent had to create manually — and then hit: (a) plugin `node_modules` absent, (b) symlinked `node_modules` break Bun's child-process module resolution, (c) `db:from-prod` only loads kernel schemas (plugin tables come from plugin migrations on first boot). All three are Hilinga-specific setup facts the agent had to rediscover from scratch.
- **Setup-output piping recurred** (`| tail -50`/`tail -60` on `db:from-prod`), masking the real errors and forcing re-discovery (observation 9 confirmed).
- **"Report the blocker and stop" was ignored** when it was just one line in a longer prompt. This reinforces that the stop signal must be an enforced condition, not prose.

### Implication for the auto-steering feature (preview)

The architecture should treat the skill file and the steering mechanism as two distinct layers:

- **Skills** = declarative, always-carried knowledge ("how to create a worktree", "db:from-prod loads kernel schemas only"). Passive. Necessary but insufficient for stubborn/looping models.
- **Steering** = active, condition-triggered interventions with hard boundaries. Two confirmed high-value trigger classes from these runs:
  1. **Loop/stall detection** — N repeated attempts of the same goal with no forward progress (e.g., N runtime-setup commands with no listener) → force a "decide or report RUNTIME BLOCKER" decision point. This is the proven highest-leverage primitive.
  2. **Constraint-violation detection** — an explicit user constraint in the prompt (no-fetch, no-git-history, report-and-stop) that the agent is about to violate → block + restate the constraint. (Proven needed: "report the blocker and stop" was ignored as prose; "no git history" is routinely skirted with `git log -1`.)

Full Run 2 detail: `docs/hilinga-nanocoder-simulation-run-2026-07-22.md` (Run 2 section).
