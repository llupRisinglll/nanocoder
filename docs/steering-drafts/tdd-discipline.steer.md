<!--
DRAFT — proposal only. NOT auto-loaded (lives under docs/steering-drafts/, not
.nanocoder/steering/). Review, then move into Hilinga/.nanocoder/steering/ once
the engine support in `## Requires` below exists. See
docs/innerdaemon-steering-findings.md and docs/auto-steering-architecture.md.

REQUIRES (unbuilt, see ## Requires): a signal for "implementation edited before
a failing test exists". The `tdd` intentClass and `newTestFileExists`
criterion already exist; the ORDERING trigger (impl-edit-before-test) does not.
-->
---
id: hilinga-tdd-discipline
description: >
  Enforce failing-test-before-fix. If a small model edits implementation source
  during a bug-fix task before a regression test exists, nudge it to write the
  failing test first — the discipline that keeps a "fix" from being an unproven
  guess and gives the change a regression guard.
mode: innerdaemon
maxFires: 2
cooldownTurns: 1
condition:
  modelIn:
    - mimo-v2.5
    - '*-mini'
    - '*-flash'
    - '*-micro'
  intentClass: tdd
watch:
  successCriterion: newTestFileExists
  maxTurnsWithoutSuccess: 1
  alsoBlock: []
---

You are supervising a **bug-fix** task in the Hilinga repo under a
test-driven-development contract: a failing regression test must exist and be
seen to fail **before** the implementation is touched. The proven small-model
failure mode is to jump straight to editing the suspected source file — a
`write_file`/`string_replace` on an implementation file — with no test written,
so the "fix" is unproven and leaves no guard against regression.

## When to nudge

- The model edits an **implementation** source file (a `write_file` or
  `string_replace` on a non-`.spec`/`.test` file) while `newTestFileExists` is
  still unmet — i.e. no failing regression test has been written yet. Nudge:
  **stop; write the failing regression test first.** Add a spec that reproduces
  the bug, run it, confirm it FAILS for the right reason, and only then edit the
  implementation. One to three sentences.
- If the model has written a test but never ran it (no red observed), nudge it
  to run the spec and confirm the failure before editing — a test that was
  never seen to fail can't prove the fix.

## When to noop

- A failing regression test already exists this task (`newTestFileExists` met)
  — the model has earned the right to edit implementation; return `noop`.
- The edit is itself to a spec/test file — that's the model writing the test,
  which is exactly what we want; return `noop`.
- The task is explicitly not a bug fix (a greenfield feature, a doc change, a
  refactor with existing coverage) where test-first was not requested — return
  `noop` rather than forcing TDD where it wasn't the contract.

## Guidance to surface

- Regression-proof the test: it must fail against the current (buggy) code and
  pass once the fix lands. A spec that passes before the fix isn't covering the
  bug (see the fork's spec discipline).
- Keep the test at the smallest layer that reproduces the defect — a unit spec
  over the offending function beats a full e2e when the unit is the fault.

## Requires

This draft reuses the existing `tdd` intentClass and `newTestFileExists`
criterion, but the ORDERING trigger it needs does **not** exist yet:

1. **An "implementation edited before a failing test" signal.** Today the
   engine's budget trigger fires on *N in-scope turns without the criterion*,
   not on the *order* of edit-vs-test. To catch the impl-first edit precisely,
   add one of:
   - A new `successCriterion`/anti-criterion pair, e.g. `implEditedBeforeTest`,
     computed in `createCriterionChecker` as: a `write_file`/`string_replace`
     tool call this turn whose path is a source file that is **not** a
     `.spec.ts(x)`/`.test.ts(x)`, while `newTestFileExists` has not yet been
     met in the loop (loop-stateful, like the #2/#3 fixes). The rule would
     `alsoBlock` such an edit, or InnerDaemon would inject on it.
   - OR a small extension to `SteeringToolConstraint` so `alsoBlock` can
     express "block `write_file`/`string_replace` on a non-spec path" — the
     current `argMatches` is a positive substring list and cannot express the
     "path is NOT a spec file" negation.
2. Because `maxTurnsWithoutSuccess: 1` above only approximates "impl edited
   with no test yet", replace it with the precise trigger from (1) once built —
   the `1` is a placeholder that will over-fire on a legitimately test-first
   turn that hasn't finished writing the spec.
3. Confirm the bug-fix framing is available to the classifier (see the
   `reproduction-first` draft's note on threading the user's task kind into
   `TurnFact`), so this rule only engages on fix tasks, not feature work.
