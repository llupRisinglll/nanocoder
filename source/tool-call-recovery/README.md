# tool-call-recovery

A harness-agnostic layer that recovers malformed / text-leaked LLM tool calls — the failure mode common to weak and Chinese open models (mimo, qwen, deepseek, minimax) that emit tool calls as broken text instead of executing them.

Example it recovers (a native-tool turn where the model emitted this as plain text):

```
<tool_call>
<function=execute_bparameter name="command">lsof -i :4000 -i :4001 2>/dev/null | grep LISTEN</parameter>
</function>
</tool_call>
```

`execute_bash` got fused with `<parameter` into `execute_bparameter`, no parser matched it, and it leaked to the user. This module detects that fragment, fuzzy-matches the name back to `execute_bash`, salvages the `command`, and hands the host an executable call tagged with its recovery provenance.

## Design rule (why it's its own directory)

Zero coupling to any host harness. Inputs are generic (raw text, tool names, optional JSON schemas); outputs are plain data. This is the extraction surface — it lifts verbatim into a standalone package (`@…/tool-call-recovery`) reusable by any LLM app. Never import AI-SDK / nanocoder / ink types into this directory; the host adapts to this contract.

## Public API (`index.ts`)

- `recoverToolCalls(text, ctx): RecoveryResult` — synchronous **deterministic** recovery (tier 1). Returns `outcomes[]` (recovered / ambiguous / unrecoverable) + `strippedText`.
- `recoverWithFallback(text, ctx, { patternStore?, llmRepair?, now? }): Promise<RecoveryResult>` — the **tiered** orchestrator: deterministic → learned-store replay → injected LLM fallback, recording LLM fixes for learning.
- `detectLeakedToolCalls(text)` · `fuzzyMatchToolName(...)` · `repairToolArguments(...)` — the building blocks.
- `candidateSignature(candidate)` — the stable key a `PatternStore` keys on.

See `types.ts` for the full contract.

## Tiered recovery (cheap → smart) + learning loop

Deterministic rules can't cover every malformation the model invents — but those malformations **repeat**. So:

1. **Tier 1 — deterministic** (`recoverToolCalls`, no LLM, free): detect tool-call-shaped text (`<tool_call>` / `<function=…>` / attribute-merged corruption / `{"tool":…}` JSON); fuzzy-match the garbled name (strip fused `parameter`/`param` artifacts, normalized Levenshtein ≤ threshold, single unambiguous winner); repair args (`jsonrepair` + coercions: drop `null`/`{}` optionals, JSON-string→array, unwrap double-encoded).
2. **Tier 2 — learned-pattern store** (`PatternStore`, free): on a tier-1 miss, replay a fix we've stored for this malformation **signature**. This is how a previously-LLM-fixed shape becomes free forever.
3. **Tier 3 — LLM fallback** (`LlmRepairFn`, host-injected, last resort): hand the model the leaked text + tool list/schemas, get a corrected call, validate it against the registered tools. **Every LLM fix is recorded** into the store (tier 2 gets it free next time) and an append-only dataset (offline review → promote frequent shapes into tier-1 rules).

Confidence travels on every recovery as `provenance.confidence` — `exact` / `fuzzy-name` / `repaired-args` / `fuzzy-and-repaired` / `learned` / **`llm-repaired`** (lowest).

**The store and the LLM function are host-injected** (`FallbackOptions`) — so the module stays free of any LLM/persistence coupling. nanocoder wires its own LLM client + a JSONL store; another app wires whatever it likes.

## Safety (enforced by the HOST, informed by provenance)

The module never executes anything — it returns data. The host MUST gate execution on `provenance.confidence`:

- `exact` recovery of a read-only tool → may flow like a normal call.
- Any `fuzzy-*` / `repaired-*` recovery, or ANY recovery of a mutating/destructive tool (`bash`, `write`, `edit`) → force a confirmation prompt, EVEN in auto-accept/yolo, showing before→after (leaked text vs. the call to run).
- `ambiguous` / `unrecoverable` → do not execute; re-prompt the model with a short readable correction (never a raw parser/validation blob), bounded by a retry cap.

## Host integration (nanocoder, kept OUT of this directory)

- `experimental_repairToolCall` (`ai-sdk-client/chat/chat-handler.ts`) → calls `fuzzyMatchToolName` + `repairToolArguments` for already-parsed-but-invalid calls.
- Post-turn leaked-call detector (`hooks/chat-handler/conversation/conversation-loop.tsx`) → when a turn ends with zero tool calls but tool-call-shaped text, calls `recoverToolCalls`, routes recovered calls through the tool handler with the safety gate, and strips the leaked text.
