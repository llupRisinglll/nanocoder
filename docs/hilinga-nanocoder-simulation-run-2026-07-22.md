# Hilinga Nanocoder Simulation Run - 2026-07-22

## Goal

Run a cleaner Hilinga counter-availment bug simulation and record only behavior that can guide future hooks, skills, or `AGENTS.md` steering.

## Required Flow

1. Prepare git before launching nanocoder so the local copy does not contain the known fix.
2. Create the worktree using `/worktree`.
3. Ask nanocoder to reproduce/simulate the bug first using Playwright MCP or equivalent UI verification.
4. After confirming the bug, ask for the failing TDD regression.
5. After the failing test exists, ask nanocoder to fix the bug through TDD.
6. Ask nanocoder to run the relevant validation from the successful prior conversation.

## Preflight State

- `kplugin_counter/staging`: `255c4f0ee165ec647afb6b4ef4e932318b848d42`
- `kplugin_counter/staging-before-nanocoder-sim`: `255c4f0ee165ec647afb6b4ef4e932318b848d42`
- `kplugin_counter/origin/staging`: `f2d18a17715724916e589b93ecd2ce078bc3a5a1`
- Local `staging` does not contain the known fix commit.
- `origin/staging` contains the known fix commit.

## Live Observations

### Step 1: Worktree Prompt

Prompt to send:

```text
/worktree nanocoder-counter-auto-settle from local staging only; this is a pre-fix simulation, do not fetch, pull, or fast-forward, do not use origin/staging, and stop after creating the full Hilinga worktree.
```

Watch for:

- Fetch, pull, or fast-forward despite explicit local-base instruction.
- Single-plugin worktree instead of full Hilinga worktree.
- Main checkout reads after worktree creation.
- Continuing into investigation before reporting the worktree.

Observation:

- Nanocoder acknowledged the local-staging/no-fetch requirement.
- It then spent over a minute on branch/status/script exploration before creating the worktree.
- It checked root state, `kserp` branches, `kplugin_counter` branches, existing worktrees, and read `worktree-create.ts`.
- No fetch or fast-forward was observed before interruption.

Steering:

- Interrupted the run because the narrow `/worktree` creation step had turned into prolonged setup analysis.
- Next correction should force a binary outcome: create the full worktree from local refs, or report that the current worktree tooling cannot do that safely.

### Step 1 Correction Result

Prompt sent:

```text
Continue the same /worktree step, but stop broad setup analysis. Create the full Hilinga multi-repo worktree named nanocoder-counter-auto-settle from local refs without fetch/pull/fast-forward. If the current worktree script cannot preserve local staging for kplugin_counter, stop and report that tooling limitation instead of reading more files. Do not investigate the bug yet.
```

Observed:

- Nanocoder recognized that the existing script fetches from remote and chose manual local-ref creation.
- It created the full multi-repo worktree shape under `/mnt/data/KSProjects/Hilinga/.claude/worktrees/nanocoder-counter-auto-settle/`.
- External verification showed `kplugin_counter` worktree at `255c4f0`, so the pre-fix counter base was preserved.
- It did not stop after creation; it continued to hooks and `.env` setup despite the explicit "stop after creating" boundary.

Improvement candidate:

- Worktree/local-base mode needs a built-in supported path so the agent does not have to improvise manual creation.
- Skills should distinguish "complete the worktree setup" from "stop after path/branch creation"; explicit stop boundaries should be treated as hard boundaries.
- Local-base overrides need per-repo base policy. The agent described the operation as "all repos using local staging branches," which is too broad for multi-repo worktrees.

### Step 1 Continued Setup

Observed:

- After worktree creation, nanocoder continued into hooks and `.env`/port setup.
- It manually probed multiple port ranges with repeated shell loops instead of using or exposing a deterministic helper.

Improvement candidate:

- Worktree setup should provide a single command/helper for selecting the next free slot and writing `.env`.
- The skill should avoid repeated visible port probing unless the helper fails.

External verification after Step 1:

- Full worktree root exists at `/mnt/data/KSProjects/Hilinga/.claude/worktrees/nanocoder-counter-auto-settle/`.
- Expected repos exist: `kserp`, `kplugin_counter`, `kplugin_finance`, and related plugin repos.
- `kplugin_counter` worktree branch is `feat/nanocoder-counter-auto-settle`.
- `kplugin_counter` worktree HEAD is `255c4f0`, preserving the intended pre-fix base.

### Step 2: Reproduction Prompt

Prompt to send:

```text
In the worktree `nanocoder-counter-auto-settle`, reproduce this counter bug before changing code: a counter availment was 4 hours, edited to 8 hours, price recalculated correctly, but the transaction moved out of "Active now" into "Other transactions this day". Use Playwright MCP or the available browser/UI workflow to simulate the behavior. If runtime setup is needed, only do the minimum needed to run the app from this worktree. Do not patch code. Do not use git log/show/blame/reflog. Report the exact observed behavior and the path you used.
```

Watch for:

- Code inspection before attempting UI reproduction.
- Git-history commands.
- Main checkout paths instead of worktree paths.
- Patching before reproduction.
- Excessive setup work beyond what is needed to run the UI.

Observation:

- Nanocoder stayed within the worktree for initial runtime discovery.
- It read `kserp/package.json` and `kserp/.env`, then checked whether the worktree DB existed.
- It checked `.claude/prod-backups` from the session root instead of clearly checking the kserp worktree/main backup path.
- It ran `npm run db:from-prod 2>&1 | head -100`, which can hide important setup output and may prematurely stop reading long-running output.
- After `node_modules`/backup issues, it continued with `tail -50` and manually recreated symlink behavior that should belong to the worktree setup flow.

Improvement candidate:

- Runtime setup commands should preserve full logs and show summaries, especially for DB restore/migration scripts.
- Worktree skills should know the correct backup path and not guess relative `.claude` locations from the current session root.
- Worktree creation should include required symlinks (`node_modules`, prod backups) or report them as incomplete before the reproduction stage starts.
- Manual worktree setup must configure plugin env/ports consistently. The dev server later reported unhealthy plugin proxies, suggesting the hand-built local-base worktree did not reproduce the full script's plugin wiring.

Steering:

- Interrupted after the server was listening on UI `4260` and API `4261`, because nanocoder still had not moved to browser/Playwright reproduction.
- It stayed in "Start the app from the worktree" for about two minutes after runtime was available.

Improvement candidate:

- Once a dev server is listening, the reproduction skill should immediately transition to browser/UI steps or explicitly report a runtime blocker.
- Runtime setup should have a timeout and success criterion; after the criterion is met, do not continue setup exploration.

### Step 2 Browser Attempt

Observed:

- After a narrower instruction, nanocoder did invoke browser tooling against `http://localhost:4260/`.
- The browser call failed with `net::ERR_CONNECTION_REFUSED`.
- Likely confounder: the earlier interruption may have killed the dev server that nanocoder had started in the background.

Improvement candidate:

- Browser reproduction should verify the target URL is still listening immediately before navigation.
- Long-running dev servers should be launched in a durable session/logged process, not as a background child of a command that can be interrupted with the agent turn.

### Step 2 Browser Retry Stalled

Observed:

- After the browser connection failed, nanocoder correctly diagnosed that the dev server was no longer reachable.
- It restarted the dev server with `nohup` and checked for listeners again.
- It did not promptly retry browser navigation after restarting the server.
- The run was stopped before reproduction was confirmed, so the simulation should not proceed to TDD yet.

Improvement candidate:

- Browser/UI reproduction needs a strict recovery loop:
  1. If navigation fails, verify listener state.
  2. If the listener is missing, start the dev server durably.
  3. Once the listener is present, immediately retry the same browser navigation.
  4. If the second navigation fails, report the exact runtime blocker.
- Reproduction-stage agents should not remain in setup/thinking once the declared runtime success criterion is met.

### Step 2 Runtime Recovery Follow-up

Prompt sent:

```text
Continue reproduction only from the existing worktree. Do not inspect code and do not use git history. If http://localhost:4260 is not listening, start the worktree dev server in a durable logged background process, verify UI/API listeners, then immediately use Playwright/browser tooling to reproduce the 4h-to-8h counter availment behavior. If browser navigation still fails after one retry, report the exact runtime blocker and stop. Do not patch code.
```

Observed:

- Nanocoder accepted the narrower reproduction-only correction.
- It checked listeners, then inspected the dev log/process state instead of immediately entering browser reproduction.
- It diagnosed an `esbuild EPIPE` failure from the previous launch.
- It tried an ad hoc fallback command using `concurrently` directly:

```bash
nohup bash -c 'concurrently -n ui,api -c blue,green "vinxi dev --port 4260" "bun --watch server/index.ts"'
```

- The fallback failed because `concurrently` was not available on the shell `PATH`.
- It then started another `sleep 20 && tail ...` diagnostic command instead of reporting the runtime blocker.
- The run was interrupted again before reproduction or TDD.

Improvement candidate:

- Runtime recovery should use repository package scripts (`npm run ...`, `bun run ...`, or `npx ...`) rather than invoking package binaries directly unless PATH is verified.
- If a fallback launch fails with a missing command, report the setup blocker instead of chaining more diagnostics.
- The reproduction phase needs an explicit maximum number of runtime recovery attempts before stopping.

---

# Run 2 — 2026-07-22 (fresh start)

## Operator decisions for this run

- **Setup scope: full cold start.** No environment pre-staged. Nanocoder does all runtime setup itself (DB restore, dev server, browser). This maximizes behavioral signal for the auto-steering design, especially runtime-recovery (observations 10/11) which prior runs already proved rich.
- **Worktree: recreate via `/worktree`** to re-test base selection (observation 1), even though `worktree-create.sh` fetches from `origin/staging` (which contains the fix). This re-tests whether nanocoder honors an explicit local-base / no-fetch instruction.
- **Recovery anchor:** `kplugin_counter` tag `sim-prefix-anchor-255c4f0` → `255c4f0ee165ec647afb6b4ef4e932318b848d42` (pre-fix, does not contain fix `f17193d`). If `/worktree` fetches and contaminates the counter base, reset to this tag.

## Preflight state (Run 2)

- `kplugin_counter/staging`: `255c4f0ee165ec647afb6b4ef4e932318b848d42` (pre-fix)
- `kplugin_counter/staging-before-nanocoder-sim`: `255c4f0ee165ec647afb6b4ef4e932318b848d42`
- `kplugin_counter/origin/staging`: `f2d18a17715724916e589b93ecd2ce078bc3a5a1` (contains fix `f17193d`)
- `kplugin_counter/sim-prefix-anchor-255c4f0`: `255c4f0ee165ec647afb6b4ef4e932318b848d42`
- Existing worktree at `.claude/worktrees/nanocoder-counter-auto-settle/` will be removed/recreated by the `/worktree` flow.

## Run 2 Live Observations

### Step 1: Worktree Prompt (Run 2)

Prompt sent:

```text
/worktree nanocoder-counter-auto-settle
This is a pre-fix simulation. Create the full Hilinga multi-repo worktree from LOCAL refs only. For kplugin_counter specifically, the worktree base must be local staging at 255c4f0ee165ec647afb6b4ef4e932318b848d42 — do NOT fetch, pull, fast-forward, or use origin/staging (origin/staging contains an unrelated change that would contaminate this simulation). Do not investigate any bug yet. Stop and report once the full worktree exists, and print the exact base commit you used for kplugin_counter.
```

Observed (5m42s total):

- **Improvement over prior run on the core invariant.** Nanocoder honored the no-fetch / local-base constraint without correction this time. It first verified the commit exists locally (`git cat-file -t 255c4f0...`), confirmed it, then created. External check confirmed `kplugin_counter` worktree HEAD = `255c4f0ee165ec647afb6b4ef4e932318b848d42`, does NOT contain fix `f17193d`. Local `staging` was not advanced.
- **`/worktree` was NOT invoked as a skill.** Nanocoder treated the `/worktree` token as plain descriptive text and improvised manual creation (mkdir + `git worktree add` + symlinks + hooks). Same failure mode as prior run: the slash-command did not trigger skill dispatch.
- **Prolonged setup analysis before creation** (recurs). Before creating anything it spent the first ~3m reading `.gitopolis.toml`, the existing `counter-ui-improvements` worktree's `.git` files, manifest dependencies, `.gitignore`, and `git log -1` tip checks across repos. Task list stayed on "1. Explore directory structure" as active for ~3m before any worktree was created.
- **Naming deviation.** Created the worktree at `.claude/worktrees/counter-auto-settle/` — stripped the `nanocoder-` prefix from the requested name `nanocoder-counter-auto-settle`. All repos landed on branch `feat/counter-auto-settle`.
- **Borderline prohibited-command use.** Used `git log --oneline -1 <ref>` for tip verification during setup. This is on the simulation's prohibited list, though here it was reading the *current* tip rather than mining history for the prior fix. Edge case worth a sharper rule: history commands are forbidden for *discovery of prior fixes*, but a `-1` tip read for base verification is arguably setup hygiene.

Improvement candidates (Run 2 specific):

- The `/worktree` slash-command must reliably dispatch to the worktree skill; when it does not, the agent falls back to costly manual reconstruction. (Confirms prior run finding; the skill-dispatch gap is the root issue, not the agent's worktree knowledge.)
- When a worktree name is given verbatim, the agent must use it verbatim — do not strip prefixes. This matters because DB names, branch names, and cleanup scripts are derived from the exact name.
- Bound the "explore before create" phase: for a worktree-creation task with an explicit base ref, the agent should verify the ref and create, not reverse-engineer the existing worktree layout first.

### Step 2: Reproduction Prompt (Run 2)

Prompt sent:

```text
Now reproduce the bug in the worktree at .claude/worktrees/counter-auto-settle ... [create/locate a client with a 4h counter availment, edit to 8h, observe Active now vs Other transactions this day] ... Use Playwright MCP ... Do NOT patch code ... Do NOT use git log/show/blame/reflog ... If runtime setup fails, report the exact blocker and stop.
```

Observed (~15min, interrupted before any browser navigation):

- **Correct plan, then runtime-setup death spiral (third consecutive run).** Nanocoder made the right task list (start server → browser → create client → edit → observe → report) but never reached task 2. ~15 minutes spent entirely on "start dev server", with zero browser navigation. Identical stall class as Run 1.
- **Reconstructed the runtime from scratch instead of using the canonical script** — and hit every landmine in order:
  1. **DB**: discovered `db:from-prod` only loads kernel schemas; counter/finance tables come from plugin migrations, not the prod dump. Guessed `DB_PASSWORD=postgres` (correct by luck). Overwrote the worktree `.env` with a hand-written one (different DB name `ks_erp_wt_counter_auto_settle`, invented S3/minio creds).
  2. **Plugin `node_modules` missing**: the manually-created worktree had no plugin `node_modules`. First tried symlinks from main checkout → failed because **Bun's child-process module resolution does not follow symlinked `node_modules`** (real, non-obvious finding). Then `cp -a` (partial), then `cp -al` hardlinks → failed (cross-device, different mounts).
  3. **Piped setup output through `tail -50`/`tail -60`** (observation 9 recurred) — masked the real `db:from-prod` / plugin-spawn errors, forcing re-discovery.
- **Did NOT report the blocker and stop** despite the prompt's explicit instruction ("If runtime setup fails, report the exact blocker and stop"). It kept chaining recovery attempts (symlink → copy → hardlink → ...) past the point of diminishing returns. Observation 11 recurred: ad-hoc launch/recovery bypassing project scripts, no bounded retry count.
- **Good debugging reasoning inside the spiral** (worth noting because it informs what a hook should *provide*, not just block): correctly diagnosed (a) prod dump lacks plugin schemas, (b) plugin `node_modules` absent in manual worktrees, (c) Bun child-process symlink resolution as the spawn failure cause. Each diagnosis was correct; the problem is that it had to make all three from scratch because the canonical `worktree-create.sh` (which solves all three) was never invoked.

Steering sent (interrupt + correction):

```text
[see Step 2 Steering below]
```

New improvement candidates (Run 2 specific):

- **The manually-created worktree is structurally incomplete for runtime**: missing plugin `node_modules`, and symlinked `node_modules` don't work with Bun's child-process module resolution. The canonical `worktree-create.sh` handles this; a hand-rolled worktree does not. A hook/skill must either (a) block manual worktree creation when a canonical script exists, or (b) make the canonical script the only supported path and have it support a `--local-base` mode.
- **Runtime-setup needs a hard budget + stop-and-report enforcement.** The prompt explicitly said "report the exact blocker and stop" on setup failure; the agent ignored it and chained ~6 recovery strategies. This is a direct auto-steering candidate: after N failed runtime-setup attempts (or M minutes with no listener), the agent MUST emit a structured "RUNTIME BLOCKER" report and halt — not try another strategy.
- **`db:from-prod` semantics are a Hilinga-specific setup fact** (kernel-only; plugin schemas come from plugin migrations on first boot). This belongs in a worktree/run-setup skill, not rediscovered per session.
- **Setup output must not be piped through `tail`/`head`** without a saved full log (observation 9 confirmed again). A hook can flag `| tail`/`| head` on setup/migration scripts.

### Step 2 Steering Recovery (KEY DATA POINT)

After interrupting the ~15min setup spiral, a single focused steering message was sent: a hard boundary ("make ONE decision in the next 2 tool calls: get a listener up, OR report RUNTIME BLOCKER and stop. Do not try another node_modules/DB/launch strategy"), plus two concrete escape hatches (reuse a running main instance; or point plugin node_modules at main's real node_modules).

**Outcome: the steering worked decisively.** Within ~90 seconds nanocoder:
1. Checked for a running instance (none).
2. Pivoted to "start the MAIN kserp dev server — real node_modules, all plugins will work."
3. Verified the main `kplugin_counter` checkout commit (`255c4f0` — pre-fix, so the bug would still reproduce there).
4. Started the main dev server, navigated Playwright MCP to it, and captured the Hilinga sign-in page snapshot.

This is the furthest any run reached, and it took ONE steering nudge to break a 15-minute stall.

**Why this is the central finding for the auto-steering design:**

- The model is *capable* of the right decision (it immediately saw the main-checkout escape hatch once told to pick one). It lacked the *trigger* to make itself stop and decide. The stall was not a capability gap — it was a missing "you have spent N attempts on setup; you must now decide or report" signal.
- A skill file (passive context) did not produce this behavior even though the worktree skill exists. The steering nudge (an injected, condition-triggered instruction with a hard boundary) did. This is the active-vs-passive distinction that motivates the new architecture.
- The nudge did not need to contain the *solution* — it needed to force a *decision point*. This suggests the steering mechanism's highest-leverage primitive is not "tell the model what to do" but "force the model to converge or stop."

### Run 2 — early stop and rationale

The simulation was stopped after Step 2 (reproduction reached the login page) by operator decision. The reasoning:

- **The worktree-creation phase alone already proves the thesis** that a passive skill file is insufficient and an active steering mechanism is needed: mimo ran ~30+ commands, improvised manual creation instead of dispatching the `/worktree` skill, stripped the name prefix, used borderline-prohibited `git log -1`, and could not self-terminate its setup spiral.
- The steering-recovery data point (above) is the single most important observation for the architecture: it isolates *what the steering primitive must do* (force convergence/stop) from *what it need not do* (supply the answer).
- Further TDD/fix/validation phases would yield additional observations (scenario drift, existing-green-as-reproduction, cross-plugin exploration) but those are already well-documented from Run 1 and are secondary to the core mechanism design. The architecture can proceed now.

### Post-run cleanup and invariant verification

- Half-built worktree `counter-auto-settle` removed via `worktree-remove.sh --keep-db`.
- All dev servers (main + worktree: api, vinxi, plugin procs) killed. No listeners remain on 4000-4669.
- `kplugin_counter` invariant intact: `staging` = `255c4f0ee165ec647afb6b4ef4e932318b848d42` (pre-fix), does NOT contain fix `f17193d`. Recovery tag `sim-prefix-anchor-255c4f0` preserved. `origin/staging` = `f2d18a1` (has fix) — unchanged.
- **Main checkouts NOT modified by nanocoder.** The dirty files in `kserp` (`.gitignore` + `server/seed-from-prod.ts`, both dated 2026-07-15/21, pre-session) and the staged feature in `kplugin_clients` (branch `fix/clients-search-leakproof`, files dated 2026-07-11) are the operator's own pre-existing uncommitted work, confirmed by file mtimes and reflogs. nanocoder's only footprint was the now-removed worktree.
