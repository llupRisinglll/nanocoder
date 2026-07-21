---
title: "Tool Naming Conventions"
description: "How Nanocoder maps tool names so every model recognizes them instantly"
sidebar_order: 2
---

# Tool Naming Conventions

Different AI models are trained to recognize different tool names. A Claude
model knows `Bash` and `Read`. A GPT model trained on Codex knows `shell` and
`apply_patch`. If you send a model the wrong name, it has to figure out what
the tool does from the description — which wastes time and causes mistakes.

Nanocoder solves this by **sending each model the tool names it already knows**,
and **accepting any known alias** when the model calls a tool back.

## The problem (with an analogy)

Imagine you moved to a new school. At your old school, the principal was called
"the dean." At your new school, they are called "the headteacher." If someone
says "go see the headteacher," you know what they mean — but if they said "go
see the dean," you would be confused.

AI models are the same. They learn tool names during training:

- **Claude models** learn `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`
- **GPT / Codex models** learn `shell`, `apply_patch`, `update_plan`
- **Local models** (Ollama, llama.cpp) do not have a strong convention

If a Claude model sees `execute_bash` instead of `Bash`, it has to read the
description and guess. Sometimes it guesses wrong. Sending the name it already
knows removes the guesswork.

## How Nanocoder handles it

Nanocoder keeps an **internal name** for each tool (used by the code that runs
the tool) and translates to the **model-facing name** (what the model sees)
based on which provider you are using.

```
You type a message
       ↓
Nanocoder builds the tool list with INTERNAL names
(execute_bash, read_file, string_replace...)
       ↓
Nanocoder translates to MODEL-FACING names based on your provider
(Anthropic → Bash, Read, Edit)
(Codex → shell, apply_patch)
(Local → execute_bash, read_file)
       ↓
The model sees names it recognizes and calls them confidently
       ↓
When the model calls a tool, Nanocoder translates the name BACK
to the internal name before running it
```

You do not need to configure anything. The translation is automatic.

## The full tool name map

Here is every tool Nanocoder supports, with its name in each convention:

| What it does | Internal name | Claude Code name | Codex name | Local name |
|---|---|---|---|---|
| Run a shell command | `execute_bash` | `Bash` | `shell` | `execute_bash` |
| Read a file | `read_file` | `Read` | — | `read_file` |
| Write a new file | `write_file` | `Write` | — | `write_file` |
| Edit a file (find & replace) | `string_replace` | `Edit` | — | `string_replace` |
| Edit a file (diff/patch) | `diff_edit` | `Edit` | `apply_patch` | `diff_edit` |
| Delete/move/copy files | `file_op` | — | — | `file_op` |
| Find files by name (glob) | `find_files` | `Glob` | — | `find_files` |
| Search file contents (grep) | `search_file_contents` | `Grep` | — | `search_file_contents` |
| List directory contents | `list_directory` | `LS` | — | `list_directory` |
| Search the web | `web_search` | `WebSearch` | — | `web_search` |
| Fetch a web page | `fetch_url` | `WebFetch` | — | `fetch_url` |
| Delegate to a subagent | `agent` | `Task` | `spawn_agent` | `agent` |
| Ask you a question | `ask_user` | `AskUserQuestion` | — | `ask_user` |
| Manage a task/todo list | `write_tasks` | `TodoWrite` | `update_plan` | `write_tasks` |
| Get code diagnostics (LSP) | `lsp_get_diagnostics` | `LSP` | — | `lsp_get_diagnostics` |
| Load a skill's instructions | `skill` | `Skill` | — | `skill` |
| Lint a skill bundle | `check_skill` | — | — | `check_skill` |
| Git: status | `git_status` | — | — | `git_status` |
| Git: diff | `git_diff` | — | — | `git_diff` |
| Git: log | `git_log` | — | — | `git_log` |
| Git: add | `git_add` | — | — | `git_add` |
| Git: commit | `git_commit` | — | — | `git_commit` |
| Git: push | `git_push` | — | — | `git_push` |
| Git: pull | `git_pull` | — | — | `git_pull` |
| Git: branch | `git_branch` | — | — | `git_branch` |
| Git: stash | `git_stash` | — | — | `git_stash` |
| Git: reset | `git_reset` | — | — | `git_reset` |
| Git: create PR | `git_pr` | — | — | `git_pr` |

> **Note:** Claude Code uses `Bash` for git operations. Nanocoder has dedicated
> git tools instead, which is why the git tools do not have Claude Code
> aliases — they are a Nanocoder extension beyond what Claude Code offers.

> **Note:** `Edit` maps to both `string_replace` and `diff_edit`. When a
> Claude model calls `Edit`, it resolves to `string_replace` (the first one
> registered). The `apply_patch` alias resolves to `diff_edit`.

## Which convention does my model use?

| Your provider | Convention used | Example |
|---|---|---|
| Anthropic (Claude) | Claude Code (PascalCase) | `Bash`, `Read`, `Glob` |
| ChatGPT / Codex | Codex (snake_case) | `shell`, `apply_patch` |
| GitHub Copilot | Codex (snake_case) | `shell`, `apply_patch` |
| OpenRouter (routing to Claude) | Local (snake_case) | `execute_bash`, `read_file` |
| Google (Gemini) | Local (snake_case) | `execute_bash`, `read_file` |
| Ollama / LM Studio / local | Local (snake_case) | `execute_bash`, `read_file` |

## Accepting aliases on the way back

When the model calls a tool, it might use any name it knows. Nanocoder
accepts all of them and translates back to the internal name before running
the tool.

| The model calls | Nanocoder translates to | What runs |
|---|---|---|
| `Bash` | `execute_bash` | Shell command handler |
| `bash` | `execute_bash` | Shell command handler (case-insensitive) |
| `shell` | `execute_bash` | Shell command handler |
| `Read` | `read_file` | File reader handler |
| `apply_patch` | `diff_edit` | Diff editor handler |
| `Glob` | `find_files` | File finder handler |
| `Task` | `agent` | Subagent handler |
| `TodoWrite` | `write_tasks` | Task list handler |
| `my_custom_mcp_tool` | `my_custom_mcp_tool` | MCP handler (no alias — passes through) |

This means if you share a conversation log or a prompt written for Claude Code
or Codex, it will work in Nanocoder without changes.

## Gap analysis: what Claude Code has that we do not

The tool name registry also lets us see what tools are missing. As of this
writing, Claude Code has these tools that Nanocoder does **not** have yet:

| Claude Code tool | What it does | Status |
|---|---|---|
| `NotebookEdit` | Edit Jupyter notebook cells | Not implemented |
| `EnterPlanMode` | Enter plan mode via a tool call | Handled via UI instead |
| `ExitPlanMode` | Exit plan mode via a tool call | Handled via UI instead |

Everything else Claude Code documents (`Bash`, `Read`, `Write`, `Edit`,
`Glob`, `Grep`, `LS`, `WebFetch`, `WebSearch`, `Task`, `AskUserQuestion`,
`TodoWrite`, `Skill`, `LSP`) maps to an existing Nanocoder tool.

## Technical details for contributors

The tool name registry lives in `source/tools/tool-aliases.ts`. It exports:

- `formatForProvider(kind)` — picks the naming convention for a provider
- `displayForFormat(canonical, format)` — translates internal → model-facing
- `resolveToCanonical(name)` — translates model-facing → internal (case-insensitive)
- `remapToolKeys(tools, format)` — remaps a whole tools record's keys
- `missingClaudeCodeCapabilities(available)` — gap analysis

The outgoing translation happens in
`source/ai-sdk-client/chat/chat-handler.ts` after cache stamping. The incoming
translation happens in `source/ai-sdk-client/converters/tool-converter.ts`.

Sources for the name mapping:
- Claude Code official: <https://code.claude.com/docs/en/tools-reference>
- openclaude (Claude Code fork): tool name constants in `src/tools/`
- codex: tool name strings in `codex-rs/core/src/tools/handlers/` spec files
