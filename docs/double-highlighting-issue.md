# Double Highlighting for File Diffs — Issue Documentation

## Goal

Implement "double highlighting" (highlight within highlight) for the compact file diff display, similar to how OpenClaude renders diffs. The visual effect should be:

```
   1 -Time moves forward, whether we are ready or not. Memories are the footprints...
      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^^^^
      dim red background (unchanged words)                  intense red background (changed words)
```

- **Line-level background**: Dim color covering the entire line (both prefix and content)
- **Word-level background**: More intense/brighter color only on changed words
- This creates a "highlight within highlight" effect where changed words stand out from the already-highlighted line

---

## Codebase Context

### Technology Stack
- **Framework**: React via [Ink](https://github.com/vadimdemedes/ink) (v6) for terminal UI
- **Language**: TypeScript
- **Project**: `nanocoder` — a CLI coding agent
- **Diff library**: `diff` npm package (via `diffWordsWithSpace`)

### Key Files
| File | Purpose |
|------|---------|
| `source/utils/tool-result-display.tsx` | Compact file diff display (`CompactFileResult` component) |
| `source/utils/inline-diff.tsx` | Word-level diff computation (`computeInlineDiff`, `areLinesSimlar`) |
| `source/tools/file-ops/string-replace-preview.tsx` | Full string_replace preview (uses same diff approach) |
| `source/types/ui.ts` | Theme color types (`Colors` interface) |
| `source/config/themes.json` | Theme color definitions |
| `source/config/themes.ts` | Theme loader |

### Theme Colors (tokyo-night)
```json
{
  "diffAdded": "#1f3a28",        // Line-level green background (dim)
  "diffRemoved": "#3a1f28",      // Line-level red background (dim)
  "diffAddedWord": "#338844",    // Word-level green background (intense)
  "diffRemovedWord": "#883344",  // Word-level red background (intense)
  "diffAddedText": "#7AF778",    // Text color for added lines
  "diffRemovedText": "#f7768e"   // Text color for removed lines
}
```

### Reference Implementation
OpenClaude achieves this effect in `src/components/StructuredDiff/Fallback.tsx`. Their structure (lines 335-346):

```tsx
<Box key={key} flexDirection="row">
  <Text backgroundColor={lineBgColor} dimColor={dim}>
    {lineNumStr}{diffPrefix}
  </Text>
  <Text backgroundColor={lineBgColor} dimColor={dim}>
    {content}  {/* content contains <Text> with word-level backgrounds */}
    {' '.repeat(padding)}
  </Text>
</Box>
```

---

## How Ink 6 Renders Text (The Key Insight)

Ink 6's `squash-text-nodes.js` processes children of `<Text>` in two ways:

1. **`#text` nodes** (plain strings): Rendered as raw text, **no transform applied** — they inherit the parent's background color
2. **`ink-text` nodes** (nested `<Text>` elements): Recursively squashed, then the child's `internal_transform` is applied — this **overrides** the parent's background for those specific characters

This means:
- Plain strings → inherit outer background ✅
- `<Text>` with its own background → overrides outer background ✅

---

## Approaches We Tried

### Approach 1: Nested `<Text>` with Same Background ❌

**Code:**
```tsx
<Text backgroundColor={colors.diffRemoved} color={colors.diffRemovedText}>
  {lineNumStr} - 
  <Text>{oldParts}</Text>  {/* inner <Text> had same bg */}
</Text>
```

**Result**: Inner `<Text>` broke the outer background. The background only appeared on the inner `<Text>` elements, not on the prefix text.

**Why it failed**: The inner `<Text>` elements applied their own `internal_transform`, which overrode the parent's background for their content only.

---

### Approach 2: Inner `<Text>` with Word-Level Background ❌

**Code:**
```tsx
<Text backgroundColor={colors.diffRemoved} color={colors.diffRemovedText}>
  {lineNumStr} - 
  <Text backgroundColor={colors.diffRemovedWord}>unchanged</Text>
  <Text backgroundColor={colors.diffRemoved} bold>changed</Text>
</Text>
```

**Result**: Each `<Text>` segment had its own background, but the outer background was invisible. The visual effect was a series of adjacent colored blocks, not a continuous line with highlighted words.

**Why it failed**: Every character was inside an `<Text>` element, so every character had its own background. The outer background was never visible.

---

### Approach 3: Different Text Colors ❌

**Code:**
```tsx
<Text backgroundColor={colors.diffRemoved}>
  {lineNumStr} - 
  <Text color={colors.diffRemovedText}>unchanged</Text>
  <Text color="white" bold>changed</Text>
</Text>
```

**Result**: Changed words had different text color and bold/underline, but no background difference. The entire line had the same background.

**Why it failed**: Text color is not background color. This approach only changed the foreground, not the background.

---

### Approach 4: Plain Strings + `<Text>` for Changed Words (Current) ⚠️

**Code:**
```tsx
<Text backgroundColor={colors.diffRemoved} color={colors.diffRemovedText}>
  {lineNumStr} - 
  {'unchanged text'}  {/* plain string — inherits outer bg */}
  <Text backgroundColor={colors.diffRemovedWord} bold>changed</Text>  {/* overrides bg */}
</Text>
```

**Result**: This is the theoretically correct approach based on Ink 6's rendering behavior. Plain strings should inherit the outer background, while `<Text>` elements override it.

**Current status**: Build compiles, but visual testing is needed to confirm it works. The user reported it still doesn't show the double highlighting.

**Potential issues to investigate**:
1. The `<Text>` wrapping the content might need `wrap="truncate-end"` which could affect how children are rendered
2. The `diffRemovedWord`/`diffAddedWord` colors might not be visually distinct enough from `diffRemoved`/`diffAdded`
3. There might be a rendering order issue where the outer `<Text>`'s background is applied AFTER the inner `<Text>` overrides

---

## What Openclaude Does Differently

Looking at Openclaude's implementation more carefully:

1. They use `dimColor={dim}` on the outer `<Text>`, not `color={...}`
2. Their inner `<Text>` elements have ONLY `backgroundColor` — no `color`, no `bold`, no other props
3. They have a `NoSelect` wrapper around the prefix `<Text>`
4. They pad the content to fill terminal width

The key difference might be in how they handle the `dimColor` prop vs explicit `color` prop.

---

## Next Steps

1. **Test Approach 4** — The current implementation might actually work, needs visual verification
2. **Compare with Openclaude's exact props** — Try using `dimColor` instead of `color`
3. **Check Ink version** — Verify nanocoder uses the same Ink version as Openclaude
4. **Ask an expert** — Someone familiar with Ink's internals might know the correct approach
5. **Consider alternatives** — If Ink truly doesn't support this, consider:
   - ANSI escape codes bypassing React/Ink
   - Custom rendering component
   - Contributing to Ink to add this feature

---

## Testing

To test the current implementation:
1. Enable compact mode: `ctrl+o` or Settings → Tool Results and Thinking → Expand Tool Results: OFF
2. Ask the model to edit a file with non-adjacent changes
3. Observe the diff display — changed words should have a more intense background than unchanged words

To adjust colors, edit `source/config/themes.json`:
- `diffRemoved` / `diffAdded`: Line-level background (should be dim)
- `diffRemovedWord` / `diffAddedWord`: Word-level background (should be more intense)
