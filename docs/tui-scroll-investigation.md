# TUI Scroll/Banner Investigation — Findings & Plan

_Date: 2026-07-15. Follow-up to `development-log.md` ("all changes verified to NOT work")._

## The unifying root cause

Commit `1d04a785` put the whole app on the **alternate screen buffer** (`\x1B[?1049h` in `source/cli.tsx:452-454`). The alt screen has **no scrollback by design** — that is its defining property (vim/less use it precisely so they *don't* pollute scrollback).

Ink's `Static` component has exactly one job: print content **once** into the terminal's *native scrollback* and never repaint it. Under the alt screen, that mechanism is dead on arrival. Every Static-based fix attempted after `1d04a785` was therefore doomed regardless of its correctness — which is why nothing worked and why the failures looked so arbitrary.

The knock-on effects:

1. **Banner disappearing** — with Static neutered, `c615e125` moved the banner into the live (non-Static) region. Ink erases and rewrites the entire live region via cursor-up + clear on *every* React commit (any keystroke, any completion popup, any streaming token). When that region's height exceeds terminal rows, the top — the banner — is clipped first. `React.memo`/context-scoping fixes (`b7cad493`, `e5422abb`, `8be59ede`) couldn't help because the problem is Ink's terminal-level repaint, not React re-render fan-out.
2. **No scroll** — alt screen removed native scrollback, and stock Ink v6 has no scroll primitive. `scroll-view.tsx` (`ac4bf320`) is non-functional: its `contentHeight` is `childCount * 2` (a guess), and its `scrollTo/scrollBy` ref API has **zero callers** — no key/wheel input is wired to it. It's dead code.
3. **/clear broken** — current `/clear` is pure React state (`conversationId` remount of `<Static>` + `showWelcome`, `App.tsx:444-447`). No ANSI clear. Under the alt screen, stale rows that Ink's diff doesn't cover linger.

## What OpenClaude actually does (and why we can't copy it)

OpenClaude does **not** use Static, at all. Their Ink is a **hard fork vendored in-repo** (`src/ink/`, ~14k lines): DOM nodes carry first-class scroll state (`scrollTop`, `scrollHeight`, clamp bounds), the renderer does viewport culling (`renderScrolledChildren`) over an `overflowY:'scroll'` style stock Ink doesn't have, backed by a bespoke double-buffered cell-pool `Screen`, blit cache, and a DECSTBM hardware-scroll fast path. `useVirtualScroll` (721 lines) sits on top to bound fiber/Yoga memory for 1000+ message sessions. SGR mouse tracking feeds a wheel-acceleration engine.

**Not extractable as pnpm patches onto `ink@6.3.1`.** The scroll engine depends on a caching/blit output layer that stock Ink (single string-diff via log-update) simply doesn't have. It's a different renderer design, not a delta.

**The key insight**: in *non-fullscreen* mode, OpenClaude itself falls back to exactly the classic approach — **no alt screen, dump history to native terminal scrollback, render only a capped live window**. That fallback is the proven, low-cost architecture, and it's what stock Ink is built for.

## How the major CLIs actually render (researched 2026-07-15)

| CLI | Screen buffer | Scrollback | Renderer |
|---|---|---|---|
| **Claude Code** (2.1.210) | Dual: `default` = main screen; `fullscreen` = alt screen (opt-in, GrowthBook-gated rollout) | `default` = **native** scrollback; `fullscreen` = app-managed virtualized viewport | Ink-lineage, heavily rewritten: DECSTBM scroll regions, mode-2026 synchronized output, blit cache, virtual scroll |
| **Codex CLI** (0.144.1) | Alt screen **by default** (`tui.alternate_screen: auto`); inline via `--no-alt-screen` | Default = app-managed (Ctrl+T transcript overlay); inline mode = native scrollback via hand-rolled scroll-region escapes (`insert_history.rs`) | Rust, ratatui + crossterm, custom `Terminal` with pinned viewport |
| **Antigravity CLI** (`agy` 1.1.2) | Alt screen by default; `altScreenMode: never` opt-out, auto-degrades over SSH | Default = app-managed; `never` mode = native scrollback | Go, Bubble Tea v2 + Lipgloss (Charm stack) |
| **Cursor CLI** | Alt screen (per user reports) | App-managed only — no native fallback found | Node.js, ~22MB bundle, library unconfirmed |

Three conclusions from this:

1. **The industry has largely moved to alt-screen + app-managed scrolling as the default** (Codex, Antigravity, Cursor, and Claude Code's fullscreen mode). Native-scrollback is no longer the flagship mode anywhere except Claude Code's still-default classic renderer.
2. **Every CLI that does alt-screen well paid for a serious renderer**: Claude Code rewrote Ink's output layer (synchronized output, DECSTBM, blit cache, virtualization — its internal strings match OpenClaude's vendored fork almost symbol-for-symbol, so OpenClaude's `src/ink/` is that same renderer lineage); Codex wrote a custom ratatui `Terminal` with viewport pinning; Antigravity uses Bubble Tea v2's mature alt-screen model. **Cursor is the cautionary tale**: alt screen *without* that renderer investment, and its forums document exactly nanocoder's symptoms — fullscreen redraws every update, scroll-reset cycling, degradation as conversations grow.
3. **Everyone serious keeps a native-scrollback escape hatch** (Claude Code `default`, Codex `--no-alt-screen`, Antigravity `never`) because alt-screen mode breaks tmux copy-mode, Cmd+F, SSH, and multiplexer scrollback — there is a long trail of GitHub issues on Codex and Claude Code about precisely this.

**Where nanocoder stands**: it is currently in the Cursor trap — alt screen enabled (`cli.tsx:452`) with a renderer (stock Ink v6) that has no scroll support at all. That combination is the worst of both worlds and is the direct cause of all three bugs.

## DECISION (2026-07-15): keep the alt screen, fix the layout

Luis chose to stay on the alternate screen and make the app a true fullscreen
layout (the Codex/Antigravity model) rather than return to native scrollback.
Implemented the same day — see "Implemented fix" in `development-log.md`.
The core changes: fixed-height root (`height = stdout.rows`, reactive),
bottom-anchored chat viewport (`overflow="hidden"` + `justifyContent="flex-end"`
+ inner `flexShrink={0}` wrapper, `flexBasis={0}` so the footer never gets
crushed), no `Static` in fullscreen, `ScrollView` deleted, alt screen gated
off for run mode. In-app scrollback (a ScrollBox port — Option B below) is
the natural follow-up.

## Original recommendation (superseded): Option A — return to native scrollback

Undo the architectural mistake instead of building around it. Estimated scope: small, mostly deletions.

1. **Remove the alternate screen buffer** (`cli.tsx:450-474`, both enter and exit writes). This single change resurrects native terminal scrollback — the terminal itself becomes the scroll mechanism (mouse wheel, Shift+PgUp, etc., for free).
2. **Put the banner back inside `Static` as the first item.** Printed once into scrollback, it can never be clipped by live-region repaints. Remove the `staticComponents[0]` extraction in `app/components/chat-history.tsx:41,66-68`.
3. **Keep the live region minimal**: streaming tail + input + completions only. Completed chat turns continue flowing into `Static` (already the case via `chat-queue.tsx`). The live region then stays well under terminal height, so nothing visible ever gets clipped.
4. **Fix `/clear` with a real terminal wipe**: emit `\x1B[2J\x1B[3J\x1B[H` (clear screen + scrollback + home) alongside the existing `conversationId` remount + `showWelcome`. This is the one place an ANSI clear belongs.
5. **Delete `source/components/scroll-view.tsx`** and its call site — dead, misleading code.
6. **Fix Static item keys**: `chat-queue.tsx:38-44` falls back to `static-${index}` — give every queued component a stable key at creation so Static's append-only diffing can't misfire.

### Verification checklist (must pass in a real terminal, not just tests)

- Long conversation: wheel-scroll back through the entire history; banner is at the top of scrollback.
- Type `/` with a long history on screen — banner and history untouched.
- Arrow-key history navigation — same.
- `/clear` → pristine screen with fresh banner, no ghost rows.
- Terminal resize mid-session doesn't corrupt the live region.
- Streaming a long response: completed turns land in scrollback; only the tail repaints.

### Known trade-offs

- Exiting nanocoder leaves the session transcript in the terminal (no alt-screen restore). This is standard behavior for Claude Code/Aider/OpenClaude-fallback and arguably a feature.
- No in-app scroll UI (no `ScrollBox`) — scrolling is the terminal's job. If in-app scrolling is ever truly required (e.g. a transcript pager like OpenClaude's Ctrl+O modal), that's a separate future project: Option B below.

## Longer-term: Option B revisited — vendor OpenClaude's Ink

The CLI-landscape research upgrades Option B from "multi-week fork from scratch" to "port an existing, working renderer": OpenClaude's `src/ink/` (~14k lines, locally available at `/mnt/data/KSProjects/openclaude/src/ink/`) *is* the Claude Code fullscreen renderer lineage — ScrollBox, viewport culling, DECSTBM fast path, synchronized output, blit cache, all proven in production. Vendoring it into nanocoder would mean:

- Replacing all `from 'ink'` imports with the vendored module (API is Ink-shaped but has **no `Static`** — chat history moves inside a `<ScrollBox stickyScroll>`).
- Adopting their fullscreen layout model (banner scrolls with history; pinned elements are normal-flow siblings outside the ScrollBox).
- Porting or reimplementing wheel/key input plumbing (SGR mouse tracking, scroll keybindings).
- License check + attribution before vendoring.

This is the "do it like everyone else" path, but it's a large migration and should only follow *after* Option A restores a correct baseline. Sequencing: **A now (correct, small, matches Claude Code's default renderer), B later as an opt-in fullscreen mode** — mirroring exactly the dual-renderer strategy Claude Code, Codex, and Antigravity all ship, including keeping A as the escape hatch for tmux/SSH/multiplexer users.

## Rejected alternative

- **Option C — crude scroll on stock Ink** (clip + translate + cull patch, a few hundred lines): works but repaints the whole viewport per scroll tick — flickery on long transcripts, still needs wheel/key plumbing, and ends up as a worse version of Option B. Inferior to native scrollback (A) short-term and to a vendored proven renderer (B) long-term.
