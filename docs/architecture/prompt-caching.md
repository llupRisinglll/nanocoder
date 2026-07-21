---
title: "Prompt Caching"
description: "How Nanocoder saves time and money by reusing parts of your conversation"
sidebar_order: 1
---

# Prompt Caching

When you talk to an AI model, you pay for every word you send. The longer the
conversation gets, the more words you send, and the more it costs. **Prompt
caching** fixes this by remembering the words you already sent, so you only pay
for them once.

This page explains how Nanocoder uses prompt caching to make your conversations
faster and cheaper.

## What is prompt caching? (the short version)

Imagine you are writing a long letter to a friend. Every time you add a new
paragraph, you have to mail the *entire* letter again — even the parts your
friend already read. That would be slow and wasteful.

That is exactly what happens without prompt caching. Every time you send a new
message, the AI has to re-read your whole conversation from the start. The
system prompt, the tool list, every previous message — all of it gets
re-processed every single turn.

Prompt caching is like telling your friend: *"Remember everything up to page 4.
I'll only send you the new stuff from now on."* The AI keeps a copy of the
shared part and only processes the new messages.

| Without caching | With caching |
|---|---|
| Every turn re-processes everything | Shared prefix is processed once |
| Slower (full re-read each time) | Faster (only new content is processed) |
| Full price every turn | ~90% cheaper on cached content |

## How Nanocoder splits your prompt

Not all parts of your conversation stay the same. Nanocoder splits the prompt
into two types of blocks:

| Block type | What is in it | Changes often? |
|---|---|---|
| **Stable** | Who the AI is, the rules it follows, the tools it can use, available skills, MCP server instructions | No — same for the whole session |
| **Volatile** | The current date, your working folder, the contents of `AGENTS.md` | Yes — changes every turn or every folder |

Nanocoder puts a **cache breakpoint** on the last stable block. This tells the
AI provider: *"Everything up to here is the same as last time. Reuse it."*

The volatile blocks (date, folder, etc.) come after the breakpoint. They change
every turn, so they cannot be cached — but that is fine, because they are
small.

## What gets cached

Nanocoder places cache breakpoints on three things, in this order:

| Priority | What | Why it matters |
|---|---|---|
| 1st | **Tool definitions** | Tool schemas are large (often 5,000–15,000 tokens) and stay the same all session |
| 2nd | **System prompt** (stable part) | The AI's identity, rules, and tool guidance |
| 3rd | **Latest user message** | So the conversation prefix is ready for the next turn |

The AI provider (Anthropic) allows a maximum of **4 cache breakpoints** per
request. Nanocoder uses at most 3, so there is always room.

If the budget ever overflows, Nanocoder drops message breakpoints first (they
are the least valuable to cache) and keeps the tool and system breakpoints.

## Which providers support it

Not all AI providers support prompt caching the same way. Nanocoder handles
this automatically based on your provider:

| Provider type | Examples | How caching works |
|---|---|---|
| **Anthropic** | Claude models, Anthropic API | Full support. Nanocoder marks cache breakpoints on tools, system, and messages. |
| **OpenAI / Codex** | GPT models, ChatGPT, GitHub Copilot | Uses `prompt_cache_key` instead of breakpoints. Nanocoder sends a stable session ID so the provider can match requests. |
| **OpenAI-compatible** | OpenRouter, Ollama, LM Studio, local models | No automatic caching. Some proxies (like OpenRouter routing to Claude) may cache on their end. |

You do not need to configure anything. Nanocoder detects your provider type
and picks the right strategy.

## How to tell if caching is working

When prompt caching is active, you will see it in the debug logs:

```
AI SDK request prepared {
  promptCaching: "enabled (anthropic, 0 dropped)"
}
```

After a request finishes, the usage report includes two extra numbers:

| Field | Meaning |
|---|---|
| `cacheReadInputTokens` | Tokens served from cache (cheap — about 10% of normal price) |
| `cacheWriteInputTokens` | Tokens written to cache this turn (slightly more expensive than normal, but only happens once) |

A healthy session looks like this:

- **Turn 1:** High `cacheWriteInputTokens`, zero `cacheReadInputTokens` (writing the cache for the first time)
- **Turn 2+:** High `cacheReadInputTokens`, low or zero `cacheWriteInputTokens` (reading from cache — this is the saving)

If `cacheReadInputTokens` stays at zero on turn 2 and beyond, something is
busting the cache. The most common cause is a system prompt that changes every
turn. Nanocoder's stable/volatile split prevents this, but a custom system
prompt override set to `"replace"` mode will disable caching entirely (since
the whole prompt becomes volatile).

## The stable/volatile split in detail

Here is exactly what goes into each block:

### Stable block (cached)

These sections are built once and never change during a session:

- **Identity** — "You are Nanocoder..."
- **Core principles** — technical accuracy, conciseness, no markdown tables
- **Task approach** — how to handle simple vs. complex tasks (varies by mode)
- **Tool rules** — when to use tools, how to format calls
- **Tool-specific guidance** — file editing, git, web search, diagnostics, etc.
- **Subagent descriptions** — what each subagent does
- **Available skills listing** — names and descriptions of loaded skills
- **MCP instructions** — natural-language guidance from connected MCP servers

### Volatile block (not cached)

These sections change and must not be cached:

- **System info** — current date, working directory, OS, shell
- **AGENTS.md** — your project's custom instructions (the file can change mid-session)
- **Command/skill injections** — request-specific skill hints added per turn

## Technical details for contributors

The caching logic lives in `source/ai-sdk-client/prompt-caching.ts`. The main
entry point is `applyCachePolicy()`, which:

1. Checks if the provider supports inline cache markers (Anthropic only)
2. Allocates a 4-breakpoint budget
3. Marks the last tool definition, last stable system block, and latest user message
4. Logs a warning if any breakpoints were dropped due to budget overflow

The stable/volatile split is in `source/utils/prompt-builder.ts` — see
`buildSystemPromptBlocks()`. Each section is tagged with its cache scope, and
the chat handler (`source/ai-sdk-client/chat/chat-handler.ts`) passes the
blocks to `applyCachePolicy()`.

The design mirrors [opencode](https://github.com/sst/opencode)'s
`cache-policy.ts`, which uses the same three-position marking strategy and
the same budget allocator.
