# Hilinga Nanocoder Simulation Plan

Date: 2026-07-22

## Purpose

Evaluate nanocoder on a known successful Hilinga bug-fix workflow without leaking the known root cause or letting the harness create misleading failures.

This plan exists because earlier attempts mixed three things:

- Real nanocoder behavior.
- Supervisor steering mistakes.
- Tooling/root/indexing limitations.

The next run should make those separable.

Behavior patterns and candidate hook/skill rules from prior attempts are consolidated in `docs/hilinga-nanocoder-observations.md`.

## Target Scenario

Known successful Codex conversation:

- Session: `successful-bug-fix-0721 (019f849a-59a5-7270-bb64-b812947c8180)`
- Product area: Hilinga counter availments.
- User-visible bug: a counter availment was originally 4 hours, then edited to 8 hours. The amount recalculated correctly, but the transaction moved out of "Active now" and appeared in "Other transactions this day" as if settled.

Do not tell nanocoder the known root cause, target file, fix commit, or final patch.

## Required Flow

The simulation should follow the same shape as the original successful workflow:

1. Prepare git before launching nanocoder.
2. Ask nanocoder to create the full Hilinga worktree using `/worktree`.
3. Ask nanocoder to reproduce/simulate the bug first using Playwright MCP or equivalent UI-driven verification.
4. After confirming the bug, ask nanocoder to write the failing TDD regression.
5. Ask nanocoder to implement the fix until the failing test passes.
6. Ask nanocoder to run the same validation class as the original conversation.
7. Stop before PR merge.

## Git Preparation

Current known git facts:

- `kplugin_counter` local `staging` is intentionally behind `origin/staging`.
- Local `staging` is at `255c4f0`.
- `origin/staging` is at `f2d18a1`.
- The known fix commit is `f17193d fix: keep edited counter availments active`.
- Local `staging` does **not** contain `f17193d`.
- `origin/staging` does contain `f17193d`.

Before running:

```bash
git -C /mnt/data/KSProjects/Hilinga/kplugin_counter branch -f staging-before-nanocoder-sim staging
git -C /mnt/data/KSProjects/Hilinga/kplugin_counter rev-parse staging staging-before-nanocoder-sim origin/staging
```

Invariant:

- `staging` must equal `staging-before-nanocoder-sim`.
- `staging` must not contain `f17193d`.

Do not let the `/worktree` flow fetch/fast-forward `kplugin_counter/staging` before the simulation branch is created.

## Worktree Requirement

The simulation should use the full Hilinga multi-repo worktree, not a single-plugin worktree.

Correct target shape:

```text
/mnt/data/KSProjects/Hilinga/.claude/worktrees/nanocoder-counter-auto-settle/
  kserp/
  kplugin_counter/
  kplugin_finance/
  ...
```

Wrong shape for this simulation:

```text
/mnt/data/KSProjects/Hilinga/kplugin_counter/.claude/worktrees/nanocoder-counter-auto-settle/
```

Single-plugin worktrees do not match the original successful workflow and should not be used for this simulation.

## Base-State Problem

`worktree-create.sh` creates repo worktrees from `origin/staging`, which currently contains the fix. That contaminates the simulation.

Preferred setup options, in order:

1. Add or use a full-worktree script option that supports local base refs, such as `--local-base staging` or `--no-fetch`.
2. Manually create the full worktree with the normal script, then reset only the generated `kplugin_counter` worktree to `255c4f0` before giving the bug task to nanocoder.
3. If neither is acceptable, do not run the simulation yet; first improve the worktree tooling.

Important: if option 2 is used, document it clearly as pre-run setup, not as nanocoder's own debugging work.

## Nanocoder Prompt Sequence

### Prompt 1: Worktree

Use the actual slash command first:

```text
/worktree nanocoder-counter-auto-settle
```

Expected observation:

- Does nanocoder ask which repo?
- Does it use the full Hilinga script or single-repo Git worktree?
- Does it fetch/fast-forward despite the local pre-fix requirement?

If it attempts to fetch/fast-forward `kplugin_counter/staging`, interrupt and record it.

### Prompt 2: Bug Reproduction

After the full worktree exists and `kplugin_counter` is confirmed pre-fix:

```text
In the worktree `nanocoder-counter-auto-settle`, reproduce this counter bug before changing code: a counter availment was 4 hours, edited to 8 hours, price recalculated correctly, but the transaction moved out of "Active now" into "Other transactions this day". Use Playwright MCP or the available browser/UI workflow to simulate the behavior. Do not patch code yet. Report the exact observed behavior and the path you used.
```

Expected observation:

- Does it use Playwright MCP/browser-like tools?
- Does it try to inspect code first instead of reproducing?
- Does it need app/server startup details?
- Does LSP reduce broad grep/cat exploration?

### Prompt 3: TDD

Only after reproduction is confirmed:

```text
Now write the smallest failing regression test for the reproduced bug. Run only that targeted test and show that it fails. Do not patch implementation yet.
```

Expected observation:

- Does it write the failing test before implementation?
- Does the test target the user-visible behavior rather than a guessed internal cause?
- Does it stop if the test passes unexpectedly?

### Prompt 4: Fix

Only after a failing test is observed:

```text
Now implement the minimal fix to make the failing regression pass. Keep the change scoped. Then rerun the targeted test.
```

Expected observation:

- Does it identify the right layer?
- Does it make a minimal change?
- Does it avoid copying from git history?

### Prompt 5: Validation

After targeted test passes:

```text
Run the relevant validation from the original successful workflow: focused unit suite, full counter tests, and typecheck. Do not merge a PR.
```

Expected observation:

- Does it run targeted and broad tests appropriately?
- Does it create a changeset or PR without being asked?
- Does it leave unrelated files untouched?

## Prohibited During Simulation

Nanocoder should not use:

```text
git log
git show
git blame
git reflog
```

for discovering the prior fix.

If any of these appear, interrupt and record as history-mining.

## Things To Record

Record every steering intervention with:

- Timestamp.
- What nanocoder did.
- Why it was wrong or acceptable.
- Exact correction sent.
- Whether it recovered.

Record separately:

- Harness mistakes.
- Nanocoder model behavior.
- Tooling/indexing/LSP limitations.
- Hilinga worktree-script limitations.
- TUI rendering/capture issues.

## Known Harness Mistakes To Avoid

- Do not reveal the root cause.
- Do not reveal `f17193d`.
- Do not name `ui/remote/lib/chains.ts`.
- Do not tell it the one-line fix.
- Do not constrain the worktree to one plugin.
- Do not let current `origin/staging` be used for `kplugin_counter` without resetting to pre-fix state.

## Cleanup

After each simulation run:

```bash
cd /mnt/data/KSProjects/Hilinga
./worktree-remove.sh nanocoder-counter-auto-settle
```

Verify:

```bash
ls -d /mnt/data/KSProjects/Hilinga/.claude/worktrees/nanocoder-counter-auto-settle 2>/dev/null || true
ps -eo pid,ppid,stat,etime,cmd | rg 'nanocoder-counter-auto-settle|worktree-create' || true
git -C /mnt/data/KSProjects/Hilinga/kplugin_counter rev-parse staging staging-before-nanocoder-sim
```
