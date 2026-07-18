# Omnicode

**An alternative to Claude Code and opencode: a fork of Nanocoder that ships its unreleased features first.**

[简体中文](README.zh-CN.md) (not yet updated to the new structure)
[繁體中文](README.zh-TW.md) (not yet updated to the new structure)

Omnicode is a fork of [Nanocoder](https://github.com/Nano-Collective/nanocoder) that seeks to aggressively pull its unreleased work forward in order to:

- Give developers building agentic CLI workflows a real alternative to Claude Code and opencode, without locking them to one model provider
- Put Nanocoder's experimental and unreleased changes (the `rc/*` branches) in users' hands before they land upstream
- Keep everything open — no telemetry, no proxy hacks propping up closed binaries
- Contribute finished work back upstream once it has proven itself here, rather than diverging permanently

Omnicode exists because switching between CLI coding tools got tiring: one tool locks you to a provider, another has no flexibility. Rather than fight closed agentic tools with env hacks and proxies, this fork shapes Nanocoder around the features actually needed, and sends them upstream when they're ready. Bring your own model, keep your code on your machine: run agentic coding on the model of your choice — local models via Ollama, or any OpenAI-compatible API such as OpenRouter, Anthropic, and Google. Built by the [Nano Collective](https://nanocollective.org), a community collective building AI tooling not for profit, but for the community.

## Relationship to Nanocoder

Omnicode is a fork of [Nano-Collective/nanocoder](https://github.com/Nano-Collective/nanocoder) — not a rewrite, not a clone. It contains everything in Nanocoder, plus changes that haven't been released upstream yet.

New work lands on `rc/*` branches here first, then gets proposed back to the original repo once it's finished and proven: the multiline cursor navigation work is already merged upstream, and the TUI screen modes work has an open upstream PR. Omnicode is where Nanocoder's next release lives before it's a release — the same relationship Neovim has to Vim.

## What Omnicode has that Nanocoder doesn't (yet)

| Feature | Upstream status |
|---|---|
| Dual TUI screen modes — inline default / `--alt-screen` fullscreen with in-app scrolling, reliable `/clear`, graceful exit | PR open upstream |
| Omnicode theme + chat layout overhaul (rounded input/message boxes, merged tool-activity lines, truncated output previews) | Fork-exclusive |
| Session resume/continue flags (`--resume`/`--continue`) | Incubating on `rc/session-resume-continue` |
| Statusline position control (`/statusline position top\|bottom`) | Incubating on `rc/statusline` |
| Animated working/thinking indicators (`⚙ Working... (12s)`, `⚙ Thought (5s)`) | Incubating on `rc/indicators` |
| Compact file diff display with inline word highlighting | Incubating on `rc/compact-diff` |
| Optimized welcome header + conditional tips display | Incubating on `rc/welcome-header` |
| `$ARGUMENTS` pass-through for commands without declared parameters | Incubating on `rc/arguments-passthrough` |

#### Previews

<details>
<summary>Task list display (from the table above)</summary>

The task list now renders in a styled box with the user's preferred title shape, theme colors, and a progress counter:

![Task List Display](docs/task-list-display.png)

</details>

## Getting started

Omnicode isn't published to npm — this is the pre-release lane, so setup is from source:

```bash
git clone https://github.com/llupRisinglll/omnicode
cd omnicode
```

Or let the install script do the rest: `./install.sh` (detects your OS, checks prerequisites, builds, and puts `omnicode` on your PATH).

Otherwise, continue manually:

```bash
pnpm install
pnpm run build
```

`pnpm run build` compiles to `dist/cli.js` and marks it executable (bin name `omnicode`). Then make it available on your `PATH` — either link the package:

```bash
pnpm link --global   # or: npm link
```

or symlink the binary directly:

```bash
mkdir -p ~/.local/bin
ln -s "$(pwd)/dist/cli.js" ~/.local/bin/omnicode
# already executable after `pnpm run build`; if not, run: chmod +x dist/cli.js
```

Either way, running `omnicode` should now start the CLI.

### CLI Flags

Specify provider, model, and starting mode directly:

```bash
# Non-interactive mode with specific provider/model
omnicode --provider openrouter --model google/gemini-3.1-flash run "analyze src/app.ts"

# Interactive mode starting with specific provider
omnicode --provider ollama --model llama3.1

# Flags can appear before or after 'run' command
omnicode run --provider openrouter "refactor database module"

# Boot directly into a development mode (normal, auto-accept, yolo, plan)
omnicode --mode yolo
omnicode --mode plan run "audit the auth module"

# Fullscreen mode with in-app scrolling instead of the inline default
omnicode --alt-screen
```

## Documentation

Further reference lives in the [docs/](docs/) folder, plus upstream's doc site at [docs.nanocollective.org](https://docs.nanocollective.org/nanocoder/docs).

## Why a collective

Omnicode is built by the Nano Collective rather than a company, and that shapes the tool itself. There are no paid tiers, no telemetry quietly shipping your prompts somewhere, and no roadmap steered by what monetises best — the people building it are the people using it. Building in the open as a collective means the harness stays multi-provider on principle: you are never locked to one vendor's model, and the conventions, tests, and release standards are shared across every Nano Collective project so the work stays legible and contributable.

It is also bigger than one tool. The collective is assembling an open ecosystem of AI tooling — see the [other projects](https://nanocollective.org) — and contributors who show up now help shape what that becomes.

## Sponsors

Omnicode is built not for profit, but for the community, and that work is funded by sponsors. [Become one](https://nanocollective.org/sponsor).

### [Atlas Cloud](https://www.atlascloud.ai/console/coding-plan)

<p>
  <a href="https://www.atlascloud.ai/console/coding-plan" title="Atlas Cloud">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://nanocollective.org/sponsors/atlas-cloud-white.png">
      <img alt="Atlas Cloud" height="40" src="https://nanocollective.org/sponsors/atlas-cloud-black.png">
    </picture>
  </a>
</p>

> Atlas Cloud is a full-modal AI inference platform that gives developers a single AI API to access video generation, image generation, and LLM APIs. Instead of managing multiple vendor integrations, you connect once and get unified access to 300+ curated models across all modalities.

Check out [Atlas Cloud's new coding plan promotion](https://www.atlascloud.ai/console/coding-plan) for more budget-friendly API access.

## Community

The Nano Collective is a community collective building AI tooling for the community, not for profit. We'd love your help.

- **Contribute**: See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.
- **The collective**: [nanocollective.org](https://nanocollective.org) · [docs](https://docs.nanocollective.org) · [GitHub](https://github.com/Nano-Collective) · [Discord](https://discord.gg/ktPDV6rekE)
- **Support the work**: The [Support page](https://docs.nanocollective.org/collective/organisation/support) covers donations and sponsorship.
- **Paid contribution**: The [Economics Charter](https://docs.nanocollective.org/collective/organisation/economics-charter) sets out how scoped paid bounties work.
