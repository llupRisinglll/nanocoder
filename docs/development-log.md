# Development Log

## 2026-07-15 (final): Inline mode is now the DEFAULT + clean exit

- **Default flipped**: inline mode (main screen, native scrollback) is the
  default. Fullscreen is opt-in via `--alt-screen` or
  `"alternateScreen": true` in preferences; `--no-alt-screen` still forces
  inline over the preference.
- **MCP server stderr no longer inherited** — stdio MCP transports now use
  `stderr: 'pipe'` drained into the logger (`transport-factory.ts` +
  `mcp-client.ts`). Previously a server child (e.g. Playwright MCP) that
  crashed with EPIPE while nanocoder was shutting down dumped its stack
  trace onto the user's terminal AFTER the shell prompt returned. The
  child's death is its own business; it just can't scribble on the
  terminal anymore.
- **Clean exit** (Ctrl+C and /exit): Ink's `exitOnCtrlC` is disabled;
  Ctrl+C routes through the shutdown manager like /exit. A priority-0
  shutdown handler (`tui-exit-render` in cli.tsx) does
  `clear() → unmount() → restore screen → print "Exiting..."`. The
  clear-before-unmount order is load-bearing (clear syncs the erased frame
  so unmount skips its final rewrite; unmount stops late state updates from
  repainting). Result: inline exits leave the banner/transcript +
  "Exiting..."; fullscreen exits restore the original shell +
  "Exiting...". A second Ctrl+C during shutdown force-quits.

## 2026-07-15 (later): Hybrid screen modes + mouse wheel

Follow-ups from Luis's manual testing:

- **Mouse wheel scrolling in fullscreen** — SGR mouse reporting (DECSET
  1000/1006) enabled on the alt screen. Ink reads stdin through a filter
  (`source/utils/terminal-mouse.ts`, unit-tested) that strips mouse escape
  sequences (clicks would otherwise leak into the input as text) and routes
  wheel ticks to the chat viewport (3 rows/tick). Text selection needs
  Shift+drag while mouse reporting is on — standard fullscreen-TUI cost.
- **Resize residue fix** — on terminal resize cli.tsx wipes the screen
  before Ink repaints (growing the window used to leave stale rows: Ink's
  diff only erased the old smaller frame).
- **Hybrid screen modes** (the Codex/Claude Code pattern), since the
  terminal's native scrollbar fundamentally cannot work on the alt screen:
  - Default: fullscreen (alt screen, fixed-height layout, in-app scroll).
  - `--no-alt-screen` flag or `"alternateScreen": false` in preferences:
    inline mode — main screen, banner + finished turns print once into
    Ink's `Static` (i.e., the terminal's native scrollback), so the
    terminal scrollbar/wheel/search genuinely work. `/clear` in inline
    mode wipes screen + scrollback (`2J 3J H`).
  - `AppProps.altScreenActive` (set by cli.tsx) is the single flag that
    drives which layout renders; test renderers default to inline.

## 2026-07-15: Fullscreen layout fix (WORKING)

Root cause of all three TUI bugs was identified (see
`docs/tui-scroll-investigation.md` for the full investigation, including how
Claude Code / Codex / Antigravity / Cursor render): the app entered the
alternate screen buffer (`1d04a785`) — which has no scrollback by design —
while still rendering an unconstrained Ink flow with `Static`, whose entire
mechanism depends on native scrollback. Every fix attempted after that
commit was doomed regardless of correctness.

**The fix — a real fullscreen layout on the alt screen:**

- `interactive-app.tsx`: root Box pinned to `height = stdout.rows` (reactive
  via new `useTerminalRows` hook). Footer (modals + status + input) wrapped
  in `flexShrink={0}`; the chat area absorbs all vertical shrink.
- `chat-history.tsx`: fullscreen variant renders a bottom-anchored clipped
  viewport: `overflow="hidden"` + `justifyContent="flex-end"` + inner
  `flexShrink={0}` wrapper + `flexBasis={0}`. Two Yoga traps found
  empirically: without the inner `flexShrink={0}` wrapper Yoga shrinks each
  child and every other line disappears; without `flexBasis={0}` the chat
  area's basis is the full transcript height and Yoga crushes the footer
  proportionally (input box loses rows).
- `chat-queue.tsx`: `disableStatic` mode — no `Static` in fullscreen (it
  cannot work on the alt screen); renders a 60-component tail in regular
  flow so layout cost stays bounded.
- `scroll-view.tsx`: deleted (non-functional dead code — scroll API had
  zero callers, content height was `childCount * 2`).
- `cli.tsx`: alt screen now gated to interactive TTY only; run mode
  (`nanocoder run`) previously lost its transcript on exit.
- Fullscreen layout activates only when `process.stdout.isTTY` — test
  renderers and piped stdout keep the classic flow layout.

**Verified via pty harness (pyte)**: banner shows on launch and RETURNS
after completions close (previously gone forever); `/` completions shrink
the chat area instead of corrupting it; long output clips at the top with
input pinned; `/clear` resets to a pristine banner screen; vertical resize
(30→20→30 rows) adapts cleanly both directions.

Known limitation (accepted): no in-app scrollback yet — content that clips
off the top is not viewable. That's the planned Option B follow-up
(ScrollBox port, see investigation doc).

## Changes Since Omnicode Rebrand (8129d17b)

### Context

After rebranding nanocoder to Omnicode, several TUI (Terminal User Interface) issues were identified that needed fixing:

1. **Banner disappearing** — The welcome banner would disappear when typing `/` (command completions appeared) or when navigating command history
2. **No scroll support** — Chat history would scroll off-screen and disappear when content exceeded terminal height
3. **/clear command** — The `/clear` command didn't properly reset the TUI to show a fresh banner

### Attempted Changes

```
7808af3b docs: update development log with honest status of changes
e9fca208 docs: add development log with recent changes and commits
ac4bf320 feat: add ScrollView component for scroll support
f80c6bad fix: restore Static component for scrollback, fix /clear to show banner
24910e80 chore: remove debug console.error logs
2e9b0077 fix: remove Static component entirely, render all content in regular...
8be59ede fix: memoize ChatQueue props to prevent banner re-rendering when liv...
770a54f0 fix: use refs for initial provider/model to prevent banner recreation
7cab5137 fix: always render ChatQueue to show chat responses
c615e125 fix: render banner outside Static to prevent scrolling off-screen
e5422abb fix: move UIStateProvider inside InteractiveApp to isolate ChatInput...
1d04a785 feat: use alternate screen buffer like vim/less, fix /clear to prope...
4b67be08 fix: reset static components on /clear to properly clear TUI content
9c3ed1e8 fix: initialize Static items ref on first render
66d510ae fix: stabilize Static items reference to prevent banner disappearing...
fdae8e26 fix: use conversationId (UUID) to force re-render on /clear, matchin...
a63e8940 fix: use ref for staticComponents to prevent unnecessary re-renders ...
b7cad493 fix: wrap ChatHistory with React.memo to prevent unnecessary re-renders
3cb2cd2e fix: memoize theme and title shape context values to prevent unneces...
d1dbde0a feat: clear terminal on startup and restore on exit, fix /clear beha...
32f4974d feat: /clear now uses ANSI escape codes to clear terminal screen
fb655a19 feat: /clear now resets screen by forcing re-render of Static component
c00a577f feat: /clear now resets screen to fresh launch state with welcome me...
c7d0b771 fix: preserve nanocoder config compatibility while keeping omnicode ...
```

### What Was Attempted

**Banner Issues:**
- Moved banner outside Ink's `Static` component to prevent it from being pushed off-screen
- Added `React.memo` to prevent unnecessary re-renders
- Memoized context values (theme, title shape) to prevent cascading re-renders
- Used `conversationId` (UUID) to force re-render on `/clear`
- Moved `UIStateProvider` inside `InteractiveApp` to isolate re-renders

**Scroll Support:**
- Created a basic `ScrollView` component using `overflow: hidden` and `marginTop` shifting
- Attempted to use `ink-scroll-view` npm package (incompatible with current Ink setup)
- Investigated OpenClaude's custom Ink implementation (requires their modified Ink fork)

**/clear Command:**
- Added alternate screen buffer (like vim/less) for terminal isolation
- Added ANSI escape codes to clear terminal screen
- Attempted to reset `staticComponents` on `/clear`
- Used `conversationId` UUID to force re-render (matching OpenClaude's approach)

**Performance:**
- Memoized `ChatQueue` props to prevent unnecessary re-renders
- Used refs for static components to prevent re-renders
- Wrapped `ChatHistory` with `React.memo`

### Status

**All of these changes have been verified to NOT work.**

The TUI scrolling and banner issues remain unresolved. The root causes are:

1. **Ink's `Static` component uses `position: absolute`** — This renders content above everything else, which pushes the banner down when new content is added

2. **No scrollback in standard Ink** — When content exceeds terminal height, older content scrolls off-screen and disappears. OpenClaude has a custom Ink fork with `ScrollBox` support that nanocoder cannot use directly

3. **`UIStateProvider` causes cascading re-renders** — When command completions appear, the entire app re-renders, affecting the `Static` component

### Root Cause Analysis

The fundamental issue is that nanocoder uses standard Ink (v6.3.1), while OpenClaude has a heavily modified Ink fork with:
- Custom `ScrollBox` component with viewport culling
- Modified renderer with scroll position tracking
- `useVirtualScroll` hook for React-level virtualization
- Custom DOM element handling for scroll state

These modifications are deeply integrated into Ink's renderer and cannot be ported as standalone components.

### Next Steps (If Pursued)

1. **Port OpenClaude's custom Ink** — Significant effort, requires understanding their entire Ink fork
2. **Implement custom scroll mechanism** — Use `ink-scroll-view` package with proper content height measurement
3. **Reconsider architecture** — May need to rethink how the TUI handles content flow

### Files Modified

- `source/components/chat-queue.tsx`
- `source/components/chat-history.tsx`
- `source/components/scroll-view.tsx` (new)
- `source/app/App.tsx`
- `source/app/sections/interactive-app.tsx`
- `source/app/components/chat-history.tsx`
- `source/cli.tsx`
- `source/components/user-input.tsx`
