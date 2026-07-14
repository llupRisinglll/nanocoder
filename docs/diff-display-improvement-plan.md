# Diff Display Improvement Plan

## Goal

Make nanocoder's file-edit diff display match a real git-style diff viewer (reference: the delta/IDE-style screenshot from 2026-07-14):

1. Full hunks, not a 6-line teaser
2. Correct line alignment for scattered/mid-block edits (real diff, not lock-step walking)
3. Syntax highlighting inside diff lines, layered under the diff backgrounds
4. Dual line numbers (old/new) like git
5. One coherent diff block per file per turn, instead of one block per tool call

Double highlighting (dim line bg + intense word bg) already works — this plan builds on it, it does not change that mechanism.

## Current state

Two independent, divergent diff renderers exist:

| Renderer | File | Used when | Problems |
|---|---|---|---|
| `CompactFileResult` | `source/utils/tool-result-display.tsx` | After a `string_replace`/`write_file`/`diff_edit` executes, compact mode | 6-line cap, lock-step alignment, no syntax highlight, single line-number column |
| `stringReplacePreview` | `source/tools/file-ops/string-replace-preview.tsx` | Tool-confirmation preview + expanded result | Lock-step alignment, syntax highlight on context lines only, single line-number column |

Both duplicate the same word-diff segment building (`computeInlineDiff` + plain-string/nested-`<Text>` assembly). Assets already in the repo: `diff` v9 (has `diffLines`/`structuredPatch`), `cli-highlight` (already used in the preview and markdown parser), `source/services/` file snapshots, and the word-level theme colors shipped for all 50 themes.

## Architecture decision

**Build one shared diff renderer and make both call sites thin wrappers around it.**

New module: `source/components/diff-view/`
- `compute.ts` — pure logic: hunk computation, line pairing, word-diff segmentation. Unit-testable without Ink.
- `DiffView.tsx` — Ink component: takes `{oldText, newText, language, startLineOld, startLineNew, maxLines?, width}` and renders the diff block.
- `syntax.ts` — ANSI-aware syntax highlighting helpers.

Everything below lands inside this module; the two call sites shrink to data-gathering.

---

## Phase 1 — Correct diff computation (foundation)

**Problem:** both renderers walk `oldLines`/`newLines` in lock-step and pair lines by index + `areLinesSimlar`. A pure insertion mid-block shifts every subsequent comparison; deletions of non-adjacent lines (the screenshot case) misalign.

**Approach:** use `structuredPatch` from the `diff` package (already a dependency) to get real LCS hunks, then post-process each hunk the way openclaude's `Fallback.tsx` does:

1. `structuredPatch(path, path, oldText, newText, '', '', {context: 3})` → hunks of `' '`/`'-'`/`'+'` lines with correct old/new start numbers.
2. Within each hunk, group *adjacent* runs of removals followed by additions (`processAdjacentLines` pattern). Pair them 1:1 in order: removal[i] ↔ addition[i].
3. For each pair, run `computeInlineDiff` (existing) and apply the change-ratio guard openclaude uses: if changed characters / total characters > ~0.6, skip word-diff and render as plain remove+add lines. This prevents noisy word-confetti on rewrites. Unpaired leftovers render as plain lines.
4. Emit a flat list of typed line objects: `{kind: 'context'|'remove'|'add', oldLineNo?, newLineNo?, text, segments?}`.

This is `compute.ts`. **Deliverable:** pure functions + AVA specs covering: pure insertion mid-block, pure deletion, scattered deletions (the screenshot case), similar-line pairing, the change-ratio fallback, multi-hunk output, CRLF/trailing-newline edges.

## Phase 2 — Shared `DiffView` renderer

Render the Phase 1 line objects with the proven double-highlight structure (outer `<Text backgroundColor={lineBg} color={lineText}>` + plain strings + nested `<Text backgroundColor={wordBg}>`).

- **Dual line numbers:** gutter shows `old new` columns (context: both; remove: old only; add: new only), padded to the widest number in the visible range — matches git/delta. Gutter and `+`/`-` sigil live in the same background-colored `<Text>` so the line bg is continuous.
- **Full-width line background:** pad content to terminal width like openclaude does (`' '.repeat(padding)` inside the bg `<Text>`), so removed/added lines read as solid bars, not ragged text-length highlights.
- **Wrapping:** long lines wrap (not truncate) inside the diff, continuation rows keep the line bg with an empty gutter — this is what openclaude's manual wrap loop does. Reuse their strategy: wrap each word-diff part, flush rows as width fills.
- **`maxLines` prop:** cap with `...N more lines` footer when set; unlimited when not.

**Deliverable:** `DiffView.tsx` + ink-testing-library specs (render to string, assert gutter numbers, sigils, truncation footer, and that word segments appear).

## Phase 3 — Syntax highlighting under the diff colors

The screenshot's token colors come from highlighting each line, with the diff backgrounds layered underneath. Plan:

- **Context lines:** highlight the whole line with `cli-highlight` (the preview already does this — move it into `DiffView`).
- **Removed/added lines without word-diff:** highlight the whole line, then render the ANSI string inside the bg-colored `<Text>`. Verified mechanics: Ink 6 preserves SGR sequences (`sanitize-ansi.js` keeps `m`-final CSI), and chalk's close-code replacement keeps the outer bg alive across the inner fg codes. The inner `\x1b[39m` resets fall back to the outer `color` prop, so unhighlighted tokens stay readable on the bg.
- **Word-diff lines:** highlight *per segment* (unchanged segments and changed segments separately). Tokenization breaks at segment boundaries; for word-level segments this is visually acceptable and avoids the complexity of ANSI-aware slicing. If a segment fails to highlight (throws), fall back to plain text — same try/catch the preview uses today.
- **Contrast guard:** cli-highlight's default theme assumes a dark terminal. Keep the existing `getLanguageFromExtension` detection; skip highlighting when the theme's `themeType` is `light` *and* the highlight output would be unreadable — simplest v1: only apply token colors on dark themes, plain `diffAddedText`/`diffRemovedText` on light themes. Revisit with a custom cli-highlight theme derived from theme colors later.

**Risk note:** interaction between per-segment ANSI fg codes and the nested-bg trick must be re-verified with the raw-ANSI test harness used during the double-highlight fix (render with `FORCE_COLOR=3`, inspect escape codes). Add one spec that asserts a highlighted+word-diffed line still contains both bg codes.

## Phase 4 — Retire the cap; make both call sites use `DiffView`

- `stringReplacePreview`: replace its hand-rolled context/diff assembly with `DiffView` fed by (file content, old_str, new_str, match position). No cap — the confirmation preview should always show the whole edit.
- `CompactFileResult`: replace its walker with `DiffView`. Replace the hard `maxLines = 6` with a preference `compactDiffMaxLines` (default **20**, `0` = unlimited), wired through `source/config/preferences.ts` and the settings selector (`Tool Results` section, next to the existing expand toggle). 6 was a teaser; 20 covers most single edits without flooding the transcript.
- `write_file` result: render as an all-additions diff via `DiffView` (old text = previous file content from the read cache/snapshot when available, else first-N-lines preview as today).
- Delete the now-dead duplicated code paths; keep `computeInlineDiff`/`areLinesSimlar` only if `compute.ts` still uses them.

## Phase 5 — One diff block per file per turn (aggregation)

**Problem:** three `string_replace` calls to one file → three separate blocks.

**Approach — snapshot-and-flush, reusing existing machinery:**

1. The conversation loop already accumulates compact tool counts and flushes them at turn end (`displayCompactCountsSummary`, called from the chat handler). Add a parallel accumulator: `Map<filePath, {beforeContent, language}>`.
2. On the **first** edit to a file in a turn, record the pre-edit content (the file read cache in `getCachedFileContent` / the checkpoint file-snapshot service already capture this — reuse, don't re-read).
3. Suppress the per-call `CompactFileResult` when aggregation is on; show the lightweight one-liner (`⚒ Edit source/foo.ts`) per call instead so the user still sees progress.
4. At turn end, for each touched file, diff `beforeContent` vs current file content with `DiffView` and flush one block per file to the chat queue, alongside the counts summary.
5. Failure edges: file deleted mid-turn (render as full removal), edit failed (file unchanged → skip block), turn cancelled (flush whatever is recorded).

Gate this behind a preference (`aggregateFileDiffs`, default **on** in compact mode, off in expanded mode where each tool call already shows its own preview). Note: per-call blocks are what Claude Code itself does, so this phase is genuinely optional UX polish — do it last, after 1–4 have soaked.

## Order & verification

Phases are sequential; each is shippable alone. 1→2 is the core; 3, 4, 5 layer on.

Each phase ends with: `pnpm run test:types && npx biome check` clean, new AVA specs passing, plus a manual pass — `node dist/cli.js`, `ctrl+o` compact mode, exercise: (a) scattered deletions like the screenshot, (b) one-word change, (c) pure mid-block insertion, (d) multi-edit turn on one file. Verify raw ANSI with the `FORCE_COLOR=3` debug-render harness whenever the nesting structure changes.

Known baseline issues to not confuse with regressions: 5 `file-snapshot` permission specs fail in this environment on clean HEAD; `chat-input` "keeps UserInput visible" fails due to the uncommitted working-indicator WIP.
