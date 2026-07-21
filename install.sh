#!/usr/bin/env bash
#
# install.sh -- setup script for omnicode (nanocoder fork).
#
# Alternative to the manual "Getting started" steps in the README: checks
# prerequisites, installs dependencies, builds the CLI, and puts `omnicode`
# on your PATH. Safe to re-run (idempotent).
#
# Usage:
#   ./install.sh
#
# Environment overrides (useful for testing, or non-standard layouts):
#   INSTALL_BIN_DIR   Directory to place/link the `omnicode` binary into.
#                      Defaults to "$HOME/.local/bin".
#
# Exit codes: non-zero on any failed step, with the failing step named.

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() {
	printf '[install] %s\n' "$1"
}

err() {
	printf '[install] ERROR: %s\n' "$1" >&2
}

die() {
	err "$1"
	exit 1
}

manual_steps_hint() {
	printf '[install] See the "Getting started" section of README.md for manual setup steps.\n' >&2
}

# ---------------------------------------------------------------------------
# 1. OS detection
# ---------------------------------------------------------------------------

UNAME_S="$(uname -s)"
OS="unknown"

case "$UNAME_S" in
	Linux)
		OS="linux"
		if grep -qi microsoft /proc/version 2>/dev/null; then
			log "Detected WSL (Windows Subsystem for Linux); treating as Linux."
		fi
		;;
	Darwin)
		OS="macos"
		;;
	MSYS* | MINGW* | CYGWIN*)
		OS="windows"
		;;
	*)
		err "Unrecognized OS: '$UNAME_S'."
		manual_steps_hint
		exit 1
		;;
esac

log "Detected OS: $OS (uname -s: $UNAME_S)"

# ---------------------------------------------------------------------------
# 2. Repo root sanity check
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f package.json ]; then
	die "package.json not found in $SCRIPT_DIR -- run this script from the repo root."
fi

# Confirm this is actually the omnicode repo (bin.omnicode present in package.json).
if ! grep -q '"omnicode"' package.json; then
	die "This does not look like the omnicode repo (no \"omnicode\" bin entry in package.json)."
fi

log "Repo root confirmed: $SCRIPT_DIR"

# ---------------------------------------------------------------------------
# 3. Prerequisite checks: node
# ---------------------------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
	die "node is not installed. Install Node.js and re-run this script."
fi

# Read the required node version from package.json engines.node (fallback >=20).
REQUIRED_NODE_RANGE="$(node -e "
	try {
		const pkg = require('./package.json');
		process.stdout.write((pkg.engines && pkg.engines.node) || '');
	} catch (e) {
		process.stdout.write('');
	}
")"

if [ -z "$REQUIRED_NODE_RANGE" ]; then
	REQUIRED_NODE_RANGE=">=20"
	log "No engines.node in package.json; defaulting to $REQUIRED_NODE_RANGE."
else
	log "package.json requires node $REQUIRED_NODE_RANGE."
fi

# Extract the minimum major version number from a range like ">=22" or "^22.1.0".
REQUIRED_NODE_MAJOR="$(printf '%s' "$REQUIRED_NODE_RANGE" | grep -oE '[0-9]+' | head -n1)"
CURRENT_NODE_VERSION="$(node --version)"
CURRENT_NODE_MAJOR="$(printf '%s' "$CURRENT_NODE_VERSION" | grep -oE '[0-9]+' | head -n1)"

log "Detected node $CURRENT_NODE_VERSION."

if [ -n "$REQUIRED_NODE_MAJOR" ] && [ "$CURRENT_NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
	die "node $CURRENT_NODE_VERSION is too old; this repo requires node $REQUIRED_NODE_RANGE. Upgrade node and re-run."
fi

# ---------------------------------------------------------------------------
# 4. Prerequisite checks: pnpm
# ---------------------------------------------------------------------------

if ! command -v pnpm >/dev/null 2>&1; then
	log "pnpm not found."
	if command -v corepack >/dev/null 2>&1; then
		if [ -t 0 ] && [ -t 1 ]; then
			read -r -p "[install] corepack is available -- run 'corepack enable' to install pnpm? [y/N] " reply
			case "$reply" in
				[yY] | [yY][eE][sS])
					corepack enable
					;;
				*)
					die "pnpm is required. Run 'corepack enable' (or install pnpm manually) and re-run this script."
					;;
			esac
		else
			die "pnpm is required and this shell is non-interactive. Run 'corepack enable' (or install pnpm manually), then re-run this script."
		fi
	else
		die "pnpm is required and corepack was not found. Install pnpm manually (see https://pnpm.io/installation) and re-run this script."
	fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
	die "pnpm is still not on PATH after attempting to enable it. Install pnpm manually and re-run this script."
fi

log "Detected pnpm $(pnpm --version)."

# ---------------------------------------------------------------------------
# 5. Install dependencies and build
# ---------------------------------------------------------------------------

log "Running 'pnpm install'..."
if ! pnpm install; then
	die "'pnpm install' failed (see output above)."
fi

log "Running 'pnpm run build'..."
if ! pnpm run build; then
	die "'pnpm run build' failed (see output above)."
fi

CLI_PATH="$SCRIPT_DIR/dist/cli.js"
if [ ! -f "$CLI_PATH" ]; then
	die "Build succeeded but $CLI_PATH is missing."
fi
chmod +x "$CLI_PATH"

log "Build complete: $CLI_PATH"

# ---------------------------------------------------------------------------
# 6. PATH setup (per OS, never sudo)
# ---------------------------------------------------------------------------

# INSTALL_BIN_DIR lets tests (and non-standard setups) redirect where the
# `omnicode` command gets installed, instead of the real ~/.local/bin.
INSTALL_BIN_DIR="${INSTALL_BIN_DIR:-$HOME/.local/bin}"

install_via_symlink() {
	mkdir -p "$INSTALL_BIN_DIR"
	local link_path="$INSTALL_BIN_DIR/omnicode"

	if [ -L "$link_path" ]; then
		local existing_target
		existing_target="$(readlink "$link_path")"
		if [ "$existing_target" != "$CLI_PATH" ]; then
			log "Existing link at $link_path pointed to $existing_target; replacing it."
		fi
	elif [ -e "$link_path" ]; then
		log "Existing file at $link_path is not a symlink; replacing it."
	fi

	ln -sf "$CLI_PATH" "$link_path"
	log "Linked $link_path -> $CLI_PATH"

	case ":$PATH:" in
		*":$INSTALL_BIN_DIR:"*)
			: # already on PATH
			;;
		*)
			err "$INSTALL_BIN_DIR is not on your PATH."
			printf '[install] Add this to your shell profile (e.g. ~/.bashrc, ~/.zshrc):\n' >&2
			# shellcheck disable=SC2016 # literal $PATH is intentional here -- this is a line for the user to paste, not an expansion
			printf '[install]   export PATH="%s:$PATH"\n' "$INSTALL_BIN_DIR" >&2
			;;
	esac
}

install_via_link() {
	# Git Bash / Windows: symlinks from ln are unreliable (require special
	# privileges or Developer Mode), so use the package manager's global
	# link mechanism instead.
	log "Windows-style shell detected; using 'pnpm link --global' instead of a symlink."
	if pnpm link --global || (command -v npm >/dev/null 2>&1 && npm link); then
		:
	else
		err "'pnpm link --global' and 'npm link' both failed."
		printf '[install] Manual alternative: run \"pnpm link --global\" or \"npm link\" yourself from %s,\n' "$SCRIPT_DIR" >&2
		printf '[install] or invoke the CLI directly with: node "%s"\n' "$CLI_PATH" >&2
	fi
}

case "$OS" in
	linux | macos)
		# Same approach on Linux, WSL, and macOS: symlink into ~/.local/bin.
		# (On macOS with Homebrew you could instead symlink into
		# /usr/local/bin, but that typically requires sudo, so we avoid it.)
		install_via_symlink
		;;
	windows)
		install_via_link
		;;
esac

# ---------------------------------------------------------------------------
# 7. Verification
# ---------------------------------------------------------------------------

log "Verifying installation..."

if command -v omnicode >/dev/null 2>&1; then
	VERSION_OUTPUT="$(omnicode --version 2>&1)" || die "'omnicode --version' failed."
	log "omnicode is on PATH. Version: $VERSION_OUTPUT"
elif [ -x "$INSTALL_BIN_DIR/omnicode" ]; then
	VERSION_OUTPUT="$("$INSTALL_BIN_DIR/omnicode" --version 2>&1)" || die "'$INSTALL_BIN_DIR/omnicode --version' failed."
	log "omnicode is installed but not yet on PATH. Version: $VERSION_OUTPUT"
	log "Add $INSTALL_BIN_DIR to your PATH (see warning above) to use the 'omnicode' command directly."
else
	VERSION_OUTPUT="$(node "$CLI_PATH" --version 2>&1)" || die "'node $CLI_PATH --version' failed."
	log "Verified via direct invocation. Version: $VERSION_OUTPUT"
fi

log "Done."
