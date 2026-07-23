# AGENTS.md Steering Migration Plan (v2 — skill-hardening)

## 0. Core principle

Steering (InnerDaemon) has two jobs:

1. **Behavioral correction** — catch the model/harness going off-track (built: worktree, runtime-setup, tdd, reproduce rules).
2. **Reliable on-demand context** — surface scenario-specific guidance the moment its scenario is detected, so AGENTS.md stays lean. This includes **guaranteeing a skill's guidance loads when its scenario fires** — the original reason InnerDaemon exists.

**The skill-reliability problem (why this plan matters):** A skill advertises itself (its `description` is always in context) so the model *can* call it — but it often *doesn't*. The old fix was hardening prose in AGENTS.md ("remember to use skill X"), always-on and bloating every turn. Steering replaces that: slim the reminder prose, and let a steering rule be the reliable trigger.

**Decisive feasibility fact:** every Hilinga scenario skill in the router (`migration`, `frontend-discipline`, `security-audit`, `hilinga-verify`, `release-to-prod`, `hilinga-cicd`, `hilinga-prod-ops`, `hilinga-local-dev`, `ksui-publish`, `create-pr`) is a **user-triggered slash command**, NOT a model-invocable subagent. The model literally cannot call them. Only the REVIEW lenses (`review-ui`, `review-db`, …) are agents.

→ Therefore steering cannot "make the model call" a command-skill. Instead the rule **injects the skill's own body on-demand** when the scenario fires. The command file stays the single source of truth; steering is the reliable trigger. This is strictly better than hand-written announce prose, which duplicates the skill and will drift.

---

## 1. Mechanism to build: `injectSkill`

Extend the `announce` mode (already built) with one field:

```yaml
mode: announce
maxFires: 1
injectSkill: frontend-discipline   # loads .nanocoder/commands/<name>.md,
                                    # strips frontmatter, injects the body
condition: { intentClass: frontend-edit }
```

- On the first turn its scenario is detected, the engine reads the command file, strips YAML frontmatter, and injects the body as the nudge — rendered under the existing `◆ InnerDaemon · <rule-id>` header (with a "via `<skill>` skill" note).
- `injectSkill` and a literal `body` are mutually exclusive: skill-backed scenarios use `injectSkill`; reference-fact scenarios (screenshots, gitopolis) use a short literal `body`.
- Fires **once per task** (`maxFires: 1`), so a 50–300 line skill loads exactly when relevant, never every turn — the whole point.
- No model reliance, no LLM call: deterministic detector → deterministic inject.

**Verified against the fork's ACTUAL architecture (not Claude Code's docs — that lifecycle does not apply here):** nanocoder has NO progressive-disclosure Skill tool — `source/skills/registrar.ts` just fans each skill into the command/subagent/tool registries; a "skill" *is* a command, subagent, or tool. The system prompt (`source/utils/prompt-builder.ts`) is cache-scoped blocks: `stable` (subagent descriptions, coding practices, constraints) + `volatile` (system info + **AGENTS.md, re-sent every turn**). Command bodies are NOT in the system prompt (grep confirms no command-description injection); a command's body loads only on invocation, as a retained `role:'user'` message (`source/custom-commands/executor.ts:59` — "execute as if the user typed it"), and stays for the rest of the task (no ephemeral/evict path exists — verified in `conversation-loop.tsx:1178-1180`).

The gap `injectSkill` fills is specific to this architecture: a command's guidance reaches the model ONLY if the *user* types `/<cmd>` — the model cannot invoke commands, and AGENTS.md's always-on router prose is the weak, every-turn compensation. `injectSkill` lets **steering** load that body deterministically when the scenario fires — identical retained-message effect to a manual invocation, but reliably triggered. Net trade: always-on volatile router prose (every turn, every task) → on-demand command-body load (once, only in tasks where the scenario occurs). Retention is bounded to that one task and far cheaper than the prose it replaces.

Skill body sizes (lines, frontmatter-stripped): migration 119, frontend-discipline 89, security-audit 147, hilinga-verify 65, release-to-prod 128, hilinga-cicd 108, hilinga-prod-ops 49, hilinga-local-dev 38, ksui-publish 303, create-pr 197. All acceptable for a once-per-scenario load.

---

## 2. Centerpiece: convert the "Scenarios → skills" router into steering rules

The AGENTS.md **"Scenarios → skills"** block (≈24 lines) is a pure always-on router — "when X, use skill Y." Replace it wholesale with one `injectSkill` rule per scenario. Detectability varies:

| Scenario | Skill | Detector | Detectable | Status |
|---|---|---|---|---|
| Editing SolidJS UI / save handlers / ksui / theme | `frontend-discipline` | `intentClass: frontend-edit` | **high** | built (literal body → **switch to `injectSkill`**) |
| Creating a PR | `create-pr` | `userTriggeredSkill: create-pr` | **high** | built (literal body → **switch to `injectSkill`**) |
| Local dev / worktree | `hilinga-local-dev` | `intentClass: runtime-setup`/`worktree-creation`, `userTriggeredSkill: worktree` | **high** | new |
| Writing a migration / table / RLS / seed / data-move | `migration` | `pathMatches: '**/migrations/**'` + new `migration-sql` intent | **high** | new |
| Editing ksui components / publishing | `ksui-publish` | `pathMatches: '**/ksui/**'` | **high** | new |
| Operating / debugging prod or CI server | `hilinga-prod-ops` | `userTriggeredSkill: hilinga-prod-ops`/`prod-debug` + new `prod-ops` intent | **high** | new |
| Branch off staging / changeset / promote → main | `release-to-prod` | `userTriggeredSkill: release-to-prod`/`release-branch-to-prod` + new `branch-release` intent | **high** | new |
| Investigating CI/CD / wiring `PLUGIN_TOKEN` | `hilinga-cicd` | `userTriggeredSkill: hilinga-cicd` + new `ci` intent | **medium** | new |
| Verify before a PR / quality gates | `hilinga-verify` | `userTriggeredSkill: create-pr` + new `verify-gate` intent | **medium** | new |
| Security-sensitive server/UI code or audit | `security-audit` | new `security-sensitive` intent — noisy, over/under-fires | **LOW** | **keep a 1-line stub** |

**Detectability caveat:** `security-audit` (and "auditing a finished feature") has no clean deterministic signal — a keyword intent would over-fire or miss. Keep a one-line always-on pointer for it rather than gate it unreliably. Everything else detects cleanly enough for a once-per-task inject.

**REVIEW lenses (`REVIEW-<surface>.md` + `review-*` agents):** the router also says "read the surface lens UP FRONT." Two options: (a) inject the `REVIEW-<surface>.md` body on the matching surface-edit scenario, or (b) since the `review-*` are real subagents, a future "ensure the review agent ran before finishing" corrective rule. Recommend (a) for authoring-time, defer (b).

---

## 3. Non-skill movers (static-body announces)

Reference facts with no backing skill — migrate to `announce` with a short literal `body`:

| Section | Scenario | Condition | New detector | Conf |
|---|---|---|---|---|
| Screenshots | taking a Playwright screenshot | new `playwright-ui` intent | yes | high |
| Multi-repo (gitopolis) | batch git across repos | new `gitopolis` intent (`gitopolis`) | yes | high |
| BUSINESS-LOGIC.md protected | editing that file | `pathMatches: '**/docs/BUSINESS-LOGIC.md'` | no | high |
| Commit discipline (worktree) | committing in a worktree | new `commit` intent (`git add`, `git commit`) + `worktree` | yes | high |
| Timezone discipline | date/time SQL & specs | new `timezone-date` intent | yes | med |
| Tiered plugin architecture | editing a manifest | `pathMatches: '**/plugin.manifest.json'` | no | med |
| Detailed docs → kdocs/kinfra | reading/writing those repos | `pathMatches: '**/kdocs/**'`/`'**/kinfra/**'` | no | med |
| Layout (repo map) | plugin/lib build work | new `pluginlib` intent | yes | med |

**Held back (would fire nearly every turn — do NOT build):** `code-edit` for "Comments answer WHY", `verify-gate` as a broad edit trigger. A preference that announces every turn is just AGENTS.md with extra steps.

---

## 4. MUST stay always-on (safety invariants — never gate)

Gating these behind a detector risks the model acting *without* the rule when detection misses. Keep in AGENTS.md verbatim:

- **`.env.prod` naming** — a misname silently feeds live prod S3 creds to every spawned stack.
- **The independence rule** — bans `pm2 restart all`/`reload all`; never deploy/migrate/script the old prod box `188.166.229.107`.
- **Multi-tenant org-isolation core** — `workspace_id` filtering, per-workspace permission scope, RLS-in-same-migration.
- **Test policy** — never edit the assertion to make a test pass (integrity invariant, any turn).
- **Pre-existing is not exempt** — universal accountability rule, no scenario key.

Also kept (non-safety, just no reliable detector): **Session start** (turn-zero planning), **Fix every mirrored implementation** (no "a mirror exists" signal).

---

## 5. New keyword-intents to add (deduped, needed by §2–§3)

| Intent | Exact substrings | Serves |
|---|---|---|
| `playwright-ui` | `browser_navigate`, `browser_snapshot`, `browser_take_screenshot`, `playwright` | Screenshots |
| `gitopolis` | `gitopolis` | Multi-repo |
| `commit` | `git add`, `git commit` | Commit discipline (worktree) |
| `migration-sql` | `ALTER TABLE`, `CREATE TABLE`, `RLS`, `KERNEL_MIGRATIONS`, `.sql` | migration skill |
| `prod-ops` | `pm2 `, `/opt/kserp`, `ssh ` | hilinga-prod-ops skill |
| `branch-release` | `git checkout -b`, `changeset`, `git push origin` | release-to-prod skill |
| `ci` | `deploy.yml`, `plugin-ci`, `PLUGIN_TOKEN`, `gh pr checks` | hilinga-cicd skill |
| `timezone-date` | `AT TIME ZONE`, `Asia/Manila`, `timestamptz`, `::date` | Timezone discipline |
| `pluginlib` | `kplugin_`, `@kahitsan/ksui`, `build:packages` | Layout |

(`verify-gate`, `code-edit`, `security-sensitive` deliberately NOT added — too broad / unreliable.)

---

## 6. Reconciling the already-built rules

- **`hilinga-frontend-preferences`** and **`hilinga-pr-creation-preferences`** currently carry hand-written bodies. Per the core principle, **switch both to `injectSkill`** (`frontend-discipline` / `create-pr`) once the mechanism lands — kills the duplication/drift risk. Until then they work as-is.
- **`hilinga-e2e-stateless`** has NO backing skill (the e2e conventions live only in the suite), so it correctly stays a literal-body announce.

---

## 7. Recommended sequencing

**Batch 0 — build the mechanism:** add `injectSkill` to the announce mode + a skill-body loader (read command file, strip frontmatter). Regression spec. Then convert the two built rules to `injectSkill`.

**Batch 1 — highest-confidence, cleanest detectors (skill-hardening):**
1. `frontend-discipline` (frontend-edit) — switch built rule to `injectSkill`
2. `create-pr` (userTriggeredSkill) — switch built rule to `injectSkill`
3. `hilinga-local-dev` (runtime-setup/worktree)
4. `ksui-publish` (`pathMatches: '**/ksui/**'`)
5. `migration` (migrations path + `migration-sql` intent)

**Batch 2 — reference-fact movers (static body):** Screenshots, gitopolis, BUSINESS-LOGIC.md, Commit-discipline — plus retire the router prose they replace.

**Batch 3 — medium-confidence skills:** hilinga-prod-ops, release-to-prod, hilinga-cicd, hilinga-verify, timezone, layout.

Each batch: build → **you manually test in tmux** → then slim the corresponding AGENTS.md prose (keep a one-line stub only where §2/§4 says so). Nothing leaves AGENTS.md before its rule is proven live.

---

## 8. Implementation status — DONE (awaiting your tmux test)

**Mechanism (nanocoder, built into `dist/`):**
- `announce` mode + `injectSkill` field (`types.ts`, `loader.ts` resolves the sibling command body at parse time, engine injects it once per scenario). Regression spec `loader.spec.ts`.
- `ruleId` threads to the `◆ InnerDaemon · <rule-id>` header (block/inject/announce).
- 10 new keyword-intents in `intent-classifier.ts` (`gitopolis`, `commit`, `pr-create`, `prod-ops`, `ci`, `branch-release`, `migration-sql`, `timezone-date`, `pluginlib`, `playwright-ui`) + `intent-classifier.spec.ts` (11 tests, incl. over-fire guards). 124 steering specs green.

**Rules (Hilinga `.nanocoder/steering/`, 17 announce total):**
- **8 `injectSkill` skill-hardening rules**, all **activity-triggered** (NOT `userTriggeredSkill` — that double-injects, since typing the command already loads its body): frontend-discipline, create-pr (`gh pr create`), hilinga-local-dev, migration, ksui-publish, hilinga-prod-ops, release-to-prod, hilinga-cicd.
- **9 literal-body announces**: e2e-stateless, screenshots, gitopolis, business-logic-protected, commit-discipline, timezone, manifest-tier, pluginlib-layout, kdocs-kinfra.

**AGENTS.md:** 264 → 162 lines (−39%). Removed the 8 fully-covered sections; kept every safety invariant verbatim.

**Deviations from the plan (deliberate):**
- Dropped the `hilinga-verify` announce (no non-redundant trigger — the gate already lives in the always-on "Verification before declaring done" section).
- Kept `Comments answer WHY`, `Don't create issues`, `Verification`, and the `CI/CD four traps` **always-on** (no reliable detector, or safety-adjacent) rather than moving them — the reduction is 39%, not the 55–65% estimated, by design. These are candidates to move later once detectors are proven.
- `create-pr` keys on the `pr-create` **activity** intent, not `userTriggeredSkill` (redundancy fix).
