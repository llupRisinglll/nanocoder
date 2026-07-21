#!/usr/bin/env bash
#
# fork-flow.sh -- automation for the omnicode fork's feature lifecycle.
# See /mnt/data/KSProjects/NanoCollective/CLAUDE.md ("Fork Workflow" +
# "Feature lifecycle" + "Upstream PR procedure") for the rules this encodes.
#
# Usage: scripts/fork-flow.sh [<cmd>] [args] [flags]
# Run `scripts/fork-flow.sh help [<cmd>]` (or `<cmd> --help`) for details.
#
#   status                    (default) Consistency dashboard: branch fleet
#                              table (ahead/behind, pushed?, tags, open
#                              upstream PR) plus PASS/WARN checks. Read-only.
#
#   ship <branch>              Branch -> fork main via a fork PR, merge
#                              (confirmed), then pull + rebuild main checkout.
#
#   upstream <rc-branch> --body-file <f>
#                              Gated upstream-PR prep + creation + pr-<num>
#                              tagging. --body-file is REQUIRED (this script
#                              never writes PR prose).
#
#   merged <pr-num>            Post-upstream-merge ritual: retag
#                              pr-<num>-merged, merge upstream/main into fork
#                              main (confirmed), pull + rebuild.
#
#   depend <branch> <required-branch>
#                              Tag a branch dependency: dep/<branch>/on/<required>,
#                              pointed at <branch>'s current tip. Pushed to origin.
#
#   undepend <branch> <required-branch>
#                              Remove a dep/<branch>/on/<required> tag, locally
#                              and on origin.
#
# Exit codes:
#   0  success
#   1  gate failure, user abort, or runtime error
#   2  usage error (unknown subcommand/flag, missing argument)
#
# Design notes:
#   - Contamination gate (upstream Gate 2) is commit-set based, NOT
#     tip-ancestry based: (2a) the branch's unique commits vs upstream/main
#     must contain no merge commits (a branch built on fork-main history
#     inevitably carries fork-main's ship merges; clean rc branches are
#     linear), and (2b) they must share no commit with the fork-identity
#     lineage (identity refs ^upstream/main, minus commits reachable from
#     local rc/* branches -- shipped rc commits legitimately appear inside
#     stale identity snapshots and inside origin/main via ship merges, so
#     neither "in origin/main" nor "in an identity snapshot" alone is
#     contamination).
#   - The pr-<num>-merged consistency check is SQUASH-AWARE: upstream
#     squash-merges PRs, so the tagged SHAs never land verbatim on
#     upstream/main and SHA ancestry legitimately fails. Patch-id matching
#     was considered and rejected: a squash of N>1 commits produces one
#     combined patch that matches no individual commit's patch-id (verified
#     against pr-657-merged). Instead, when ancestry fails the script asks gh
#     for the PR state -- MERGED downgrades the finding to an INFO note.
#
# All state-changing commands support --dry-run (prints every mutation
# instead of running it) and prompt via confirm() before mutating.
# Requires `gh auth login`. Never runs `gh pr merge` on the upstream repo.
# Never force-pushes without --force-with-lease. Aborts politely if the main
# checkout has tracked modifications for commands that touch it (untracked
# files do not block -- they cannot break a merge).

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAIN_WORKDIR="/mnt/data/KSProjects/NanoCollective/nanocoder"
FORK_REPO="llupRisinglll/omnicode"
UPSTREAM_REPO="Nano-Collective/nanocoder"
FORK_HEAD_PREFIX="llupRisinglll"

cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

log() { echo "==> $*"; }
warn() { echo "WARN: $*" >&2; }

# Runtime / gate error -> exit 1.
die() {
	echo "ERROR: $*" >&2
	exit 1
}

usage_line() {
	echo "Usage: $0 [status|ship|upstream|merged|depend|undepend|help] [args] [--dry-run] [--no-build] [--body-file <f>]"
}

# Usage error -> exit 2.
die_usage() {
	echo "ERROR: $*" >&2
	usage_line >&2
	echo "Run '$0 help' for details." >&2
	exit 2
}

print_help() {
	local topic="${1:-}"
	case "$topic" in
		status)
			cat <<-'EOF'
			fork-flow.sh status  (default subcommand)

			Read-only consistency dashboard. Fetches all remotes, then prints:
			  - the branch fleet table (rc/* + fork/*): base, behind/ahead,
			    pushed?, pr-* tags, open upstream PR number (u-pr)
			  - consistency checks:
			      (a) open upstream PR  <->  pr-<num> tag
			      (b) pr-<num>-merged tags vs upstream/main (squash-aware:
			          SHA-ancestry failure with a MERGED PR is an INFO note,
			          because upstream squash-merges)
			      (c) README differences-table rows vs branch reality
			      (d) origin/main contains every rc/*+fork/* change set
			      (e) fork/omnicode-identity README drift (best-effort)
			      (f) fork main not behind upstream/main (ships of
			          freshly-rebased branches conflict until synced)
			      (g) dep/<branch>/on/<required> tags: SATISFIED (a
			          pr-<num>-merged tag is reachable from <required>) or
			          UNSATISFIED; WARN if <required> no longer exists locally
			          (stale tag)

			Example:  scripts/fork-flow.sh status
			EOF
			;;
		ship)
			cat <<-'EOF'
			fork-flow.sh ship <branch> [--no-build] [--dry-run]

			Merge a feature branch into the fork's main via a fork PR:
			  1. preflight: branch exists, pushed, matches origin, main
			     checkout has no tracked modifications
			  2. gate: the branch's merge-base with upstream/main must be
			     in origin/main (a branch rebased onto an upstream tip fork
			     main lacks aborts -> run 'merged <pr>' / sync main first)
			  3. if origin/main already contains patch-equivalent changes,
			     exit cleanly without modifying the branch or creating a PR
			  4. gate: mergeability probe (git merge-tree) -- conflicts
			     abort with the file list BEFORE any PR is created
			  5. confirm, then gh pr create -R llupRisinglll/omnicode
			  6. confirm, then gh pr merge --merge (keep branch)
			  7. pull --ff-only + pnpm run build in the main checkout
			     (--no-build skips the rebuild)

			Examples:
			  scripts/fork-flow.sh ship rc/statusline --dry-run
			  scripts/fork-flow.sh ship fork/readme-table-trim
			EOF
			;;
		upstream)
			cat <<-'EOF'
			fork-flow.sh upstream <rc-branch> --body-file <f> [--dry-run]

			Gated upstream-PR creation. Gates, in order:
			  1. branch is based on the current upstream/main tip (offers to
			     run scripts/update-fork-branches.sh if behind)
			  2. no fork contamination: the branch's unique commits contain
			     no merge commits (fork-main foundation) and share nothing
			     with the fork-identity commit lineage
			  3. no AI attribution in commit messages
			  4. warn on fork-identity file diffs mentioning 'omnicode'
			  5. warn on any 'omnicode' hit in the full diff
			  6. every dep/<branch>/on/<required> tag is satisfied: a
			     pr-<num>-merged tag must be reachable from <required>
			  7. build + test:types in a throwaway worktree

			Then: confirm, gh pr create -R Nano-Collective/nanocoder, tag
			pr-<num>, push the tag. --body-file is REQUIRED -- the PR body is
			human-written prose; this script never generates it.

			Examples:
			  scripts/fork-flow.sh upstream rc/statusline --dry-run --body-file /tmp/body.md
			  scripts/fork-flow.sh upstream rc/indicators --body-file body.md
			EOF
			;;
		merged)
			cat <<-'EOF'
			fork-flow.sh merged <pr-num> [--no-build] [--dry-run]

			Post-upstream-merge ritual for PR <pr-num> on the upstream repo:
			  1. resolve the PR (must be MERGED) and its branch
			  2. confirm, then: retag pr-<num>-merged (pr-<num> stays), fetch
			     upstream, merge upstream/main into fork main via a worktree
			     (aborts with instructions on conflict), push, pull + rebuild
			     the main checkout
			  3. remind to drop the README differences-table row

			Example:  scripts/fork-flow.sh merged 657 --dry-run
			EOF
			;;
		depend)
			cat <<-'EOF'
			fork-flow.sh depend <branch> <required-branch> [--dry-run]

			Tag a branch dependency: <branch>'s upstream PR must not open
			until <required-branch>'s work is released upstream. Creates
			tag dep/<branch>/on/<required-branch> pointed at <branch>'s
			current tip (for convenience only -- the tag NAME is what
			'upstream' checks, not the SHA it points at), then pushes it
			to origin.

			Validates: both branches exist locally, <branch> != <required-branch>,
			the tag doesn't already exist.

			Example:  scripts/fork-flow.sh depend rc/paste-placeholders rc/statusline
			EOF
			;;
		undepend)
			cat <<-'EOF'
			fork-flow.sh undepend <branch> <required-branch> [--dry-run]

			Removes tag dep/<branch>/on/<required-branch>, locally and on
			origin (if pushed).

			Example:  scripts/fork-flow.sh undepend rc/paste-placeholders rc/statusline
			EOF
			;;
		*)
			cat <<-'EOF'
			fork-flow.sh -- automation for the omnicode fork's feature lifecycle.

			Usage: scripts/fork-flow.sh [<cmd>] [args] [flags]

			Subcommands:
			  status                              consistency dashboard (default, read-only)
			  ship <branch>                       branch -> fork main (PR + merge + rebuild)
			  upstream <rc-branch> --body-file <f>  gated upstream PR + pr-<num> tag
			  merged <pr-num>                     post-merge ritual (retag + sync + rebuild)
			  depend <branch> <required-branch>   tag a branch dependency
			  undepend <branch> <required-branch> remove a branch dependency tag
			  help [<cmd>]                        this text, or per-subcommand help

			Flags:
			  --dry-run        print every mutation instead of running it
			  --no-build       skip the pnpm rebuild step (ship/merged)
			  --body-file <f>  PR body file for 'upstream' (required there)
			  -h, --help       help (global, or for the named subcommand)

			Exit codes:
			  0  success
			  1  gate failure, user abort, or runtime error
			  2  usage error

			Safety: every state-changing operation sits behind a confirm()
			prompt and honors --dry-run. Never merges PRs on the upstream repo.

			Examples:
			  scripts/fork-flow.sh
			  scripts/fork-flow.sh ship rc/statusline --dry-run
			  scripts/fork-flow.sh upstream rc/statusline --body-file /tmp/body.md
			  scripts/fork-flow.sh merged 657
			  scripts/fork-flow.sh depend rc/paste-placeholders rc/statusline
			EOF
			;;
	esac
}

# run CMD... -- either execute, or print under --dry-run.
run() {
	if [ "$DRY_RUN" -eq 1 ]; then
		printf '[dry-run]'
		printf ' %q' "$@"
		printf '\n'
		return 0
	fi
	"$@"
}

confirm() {
	local prompt="$1"
	if [ "$DRY_RUN" -eq 1 ]; then
		echo "[dry-run] would prompt: $prompt (auto-confirmed for --dry-run)"
		return 0
	fi
	if [ "${FORK_FLOW_YES:-}" = "1" ]; then
		echo "$prompt [auto-confirmed by FORK_FLOW_YES=1]"
		return 0
	fi
	local reply
	read -r -p "$prompt [y/N] " reply
	[[ "$reply" =~ ^[Yy]$ ]]
}

# Early environment checks: tools, auth, remotes. Every subcommand calls this.
require_tooling() {
	command -v git >/dev/null 2>&1 || die "git not found on PATH."
	command -v gh >/dev/null 2>&1 || die "gh (GitHub CLI) not found -- install it: https://cli.github.com/"
	command -v jq >/dev/null 2>&1 || die "jq not found -- install it (e.g. 'pacman -S jq')."
	gh auth status >/dev/null 2>&1 || die "gh is not authenticated -- run: gh auth login"
	git remote get-url origin >/dev/null 2>&1 \
		|| die "remote 'origin' missing -- run: git remote add origin https://github.com/$FORK_REPO"
	git remote get-url upstream >/dev/null 2>&1 \
		|| die "remote 'upstream' missing -- run: git remote add upstream https://github.com/$UPSTREAM_REPO"
}

# Only tracked modifications block (merge safety); untracked files -- including
# this script before it is committed -- are harmless and must not block.
require_clean_main() {
	if [ -n "$(git -C "$MAIN_WORKDIR" status --porcelain -uno)" ]; then
		die "main checkout ($MAIN_WORKDIR) has tracked modifications -- commit/stash before running this."
	fi
}

update_main_checkout() {
	log "Updating main checkout ($MAIN_WORKDIR)"
	if [ "$DRY_RUN" -eq 1 ]; then
		echo "[dry-run] git -C $MAIN_WORKDIR switch main"
		echo "[dry-run] git -C $MAIN_WORKDIR pull --ff-only origin main"
		if [ "$NO_BUILD" -eq 0 ]; then
			echo "[dry-run] (cd $MAIN_WORKDIR && pnpm run build)"
		fi
		return 0
	fi

	local current_branch
	current_branch="$(git -C "$MAIN_WORKDIR" branch --show-current || true)"
	if [ "$current_branch" != "main" ]; then
		git -C "$MAIN_WORKDIR" switch main
	fi
	git -C "$MAIN_WORKDIR" pull --ff-only origin main
	if [ "$NO_BUILD" -eq 0 ]; then
		(cd "$MAIN_WORKDIR" && pnpm run build)
	fi
}

# is tag $1 an ancestor-or-equal of ref $2?
tag_reaches() {
	git merge-base --is-ancestor "$1" "$2" 2>/dev/null
}

patch_reaches_main() {
	local branch="$1"
	if tag_reaches "$branch" "origin/main"; then
		return 0
	fi
	# Clean rc/* branches are intentionally rebased onto upstream/main for
	# upstream PRs. After dogfood shipping, fork main may contain equivalent
	# patches through different merge/cherry-pick SHAs. Treat that as shipped.
	! git cherry "origin/main" "$branch" 2>/dev/null | grep -q '^+'
}

branch_exists() {
	git show-ref --verify --quiet "refs/heads/$1"
}

# Branch arg validation with closest-match suggestions from the fleet.
require_branch() {
	local branch="$1"
	branch_exists "$branch" && return 0
	local fleet matches needle
	fleet=$(git for-each-ref --format='%(refname:short)' 'refs/heads/rc/*' 'refs/heads/fork/*')
	needle="${branch##*/}"
	matches=$(grep -iF -- "$needle" <<<"$fleet" || true)
	if [ -z "$matches" ] && [ "${#needle}" -ge 3 ]; then
		matches=$(grep -iF -- "${needle:0:3}" <<<"$fleet" || true)
	fi
	[ -n "$matches" ] || matches="$fleet"
	{
		echo "ERROR: branch '$branch' does not exist locally. Closest matches:"
		echo "    ${matches//$'\n'/$'\n'    }"
	} >&2
	exit 1
}

# Open upstream PR number for a head branch owned by the fork, or empty.
# gh >= 2.89 returns [] for --head "owner:branch"; filter on
# headRepositoryOwner instead.
open_upstream_pr() {
	gh pr list -R "$UPSTREAM_REPO" --head "$1" --state open \
		--json number,headRepositoryOwner \
		--jq "[.[] | select(.headRepositoryOwner.login==\"$FORK_HEAD_PREFIX\")][0].number // empty" \
		2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Temp-worktree cleanup (EXIT/INT/TERM safe, idempotent)
# ---------------------------------------------------------------------------

TEMP_WORKTREE=""
cleanup_temp_worktree() {
	if [ -n "$TEMP_WORKTREE" ]; then
		git worktree remove --force "$TEMP_WORKTREE" 2>/dev/null || true
		rm -rf "$TEMP_WORKTREE"
		TEMP_WORKTREE=""
	fi
}
trap cleanup_temp_worktree EXIT
trap 'cleanup_temp_worktree; exit 130' INT
trap 'cleanup_temp_worktree; exit 143' TERM

# ---------------------------------------------------------------------------
# Global flag / positional parsing
# ---------------------------------------------------------------------------

DRY_RUN=0
NO_BUILD=0
BODY_FILE=""
HELP=0
POSITIONAL=()

while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run)
			DRY_RUN=1
			shift
			;;
		--no-build)
			NO_BUILD=1
			shift
			;;
		--body-file)
			[ $# -ge 2 ] || die_usage "--body-file requires a value."
			BODY_FILE="$2"
			shift 2
			;;
		--body-file=*)
			BODY_FILE="${1#*=}"
			shift
			;;
		-h | --help)
			HELP=1
			shift
			;;
		-*)
			die_usage "unknown flag: $1"
			;;
		*)
			POSITIONAL+=("$1")
			shift
			;;
	esac
done

CMD="${POSITIONAL[0]:-status}"
ARG1="${POSITIONAL[1]:-}"
ARG2="${POSITIONAL[2]:-}"

if [ "$HELP" -eq 1 ]; then
	print_help "${POSITIONAL[0]:-}"
	exit 0
fi

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------

cmd_status() {
	require_tooling
	log "Fetching all remotes (origin, upstream)..."
	git fetch --all --prune --tags --quiet

	local branches
	branches=$(git for-each-ref --format='%(refname:short)' 'refs/heads/rc/*' 'refs/heads/fork/*' | sort)

	# Per-branch scratch data, parallel arrays keyed by index into $branches.
	local -a B_NAME=() B_BASE=() B_BEHIND=() B_AHEAD=() B_PUSHED=() B_TAGS=() B_PR=() B_AHEAD_MAIN=()

	local branch base behind ahead pushed tags pr ahead_main
	while IFS= read -r branch; do
		[ -n "$branch" ] || continue

		if [ "$branch" = "fork/omnicode-theme" ]; then
			base="origin/main"
		else
			base="upstream/main"
		fi

		read -r behind ahead < <(git rev-list --left-right --count "$base...$branch" 2>/dev/null || echo "? ?")

		if git rev-parse --verify --quiet "origin/$branch" >/dev/null; then
			if [ "$(git rev-parse "$branch")" = "$(git rev-parse "origin/$branch")" ]; then
				pushed="yes"
			else
				pushed="diverged"
			fi
		else
			pushed="no"
		fi

		tags=""
		for t in $(git tag -l 'pr-*' | sort -V); do
			if tag_reaches "$t" "$branch"; then
				tags="${tags:+$tags,}$t"
			fi
		done
		[ -n "$tags" ] || tags="-"

		pr=$(open_upstream_pr "$branch")
		[ -n "$pr" ] || pr="-"

		ahead_main=$(git rev-list --count "origin/main..$branch" 2>/dev/null || echo "?")

		B_NAME+=("$branch")
		B_BASE+=("$base")
		B_BEHIND+=("$behind")
		B_AHEAD+=("$ahead")
		B_PUSHED+=("$pushed")
		B_TAGS+=("$tags")
		B_PR+=("$pr")
		B_AHEAD_MAIN+=("$ahead_main")
	done <<<"$branches"

	echo ""
	echo "==================== BRANCH FLEET ===================="
	printf '%-34s %-14s %6s %6s %-10s %-16s %-6s\n' \
		"branch" "base" "behind" "ahead" "pushed?" "tags" "u-pr"
	printf '%-34s %-14s %6s %6s %-10s %-16s %-6s\n' \
		"----------------------------------" "--------------" "------" "------" "----------" "----------------" "------"
	local i
	for i in "${!B_NAME[@]}"; do
		printf '%-34s %-14s %6s %6s %-10s %-16s %-6s\n' \
			"${B_NAME[$i]}" "${B_BASE[$i]}" "${B_BEHIND[$i]}" "${B_AHEAD[$i]}" \
			"${B_PUSHED[$i]}" "${B_TAGS[$i]}" "${B_PR[$i]}"
	done
	echo "========================================================"

	echo ""
	echo "==================== CONSISTENCY CHECKS ===================="

	# (a) every branch with an open upstream PR is tagged pr-<num> and vice versa.
	local ok_a=1
	for i in "${!B_NAME[@]}"; do
		branch="${B_NAME[$i]}"
		pr="${B_PR[$i]}"
		if [ "$pr" != "-" ]; then
			if git rev-parse --verify --quiet "pr-$pr" >/dev/null && tag_reaches "pr-$pr" "$branch"; then
				: # ok
			else
				echo "WARN (a): $branch has an open upstream PR #$pr but no reachable tag 'pr-$pr'."
				ok_a=0
			fi
		fi
	done
	for t in $(git tag -l 'pr-*' | grep -v -- '-merged$' || true); do
		local num
		num="${t#pr-}"
		if git rev-parse --verify --quiet "pr-$num-merged" >/dev/null; then
			continue # already merged, tag intentionally kept -- fine.
		fi
		local state
		state=$(gh pr view "$num" -R "$UPSTREAM_REPO" --json state --jq .state 2>/dev/null || echo "UNKNOWN")
		if [ "$state" != "OPEN" ]; then
			echo "WARN (a): tag '$t' exists with no 'pr-$num-merged' counterpart, but upstream PR #$num is '$state'."
			ok_a=0
		fi
	done
	[ "$ok_a" -eq 1 ] && echo "PASS (a): open-PR <-> pr-<num> tag consistency."

	# (b) pr-<num>-merged tags vs upstream/main -- SQUASH-AWARE (see header):
	# upstream squash-merges, so SHA ancestry legitimately fails for merged
	# work; when it does, ask gh for the PR state and downgrade to INFO if
	# the PR really is MERGED.
	local ok_b=1
	for t in $(git tag -l 'pr-*-merged'); do
		if tag_reaches "$t" "upstream/main"; then
			continue
		fi
		local mnum mstate
		mnum="${t#pr-}"
		mnum="${mnum%-merged}"
		mstate=$(gh pr view "$mnum" -R "$UPSTREAM_REPO" --json state --jq .state 2>/dev/null || echo "UNKNOWN")
		if [ "$mstate" = "MERGED" ]; then
			echo "INFO (b): tag '$t' is not a SHA-ancestor of upstream/main, but PR #$mnum is MERGED -- expected, upstream squash-merges (tagged SHAs never land verbatim)."
		else
			echo "WARN (b): tag '$t' is not an ancestor of upstream/main and PR #$mnum state is '$mstate'."
			ok_b=0
		fi
	done
	[ "$ok_b" -eq 1 ] && echo "PASS (b): every pr-<num>-merged tag corresponds to merged upstream work (SHA or squash)."

	# (c) README differences-table rows vs reality.
	local ok_c=1
	local readme_table
	readme_table=$(git show origin/main:README.md 2>/dev/null | awk '
		/^\| *Feature *\| *Upstream status *\|$/ { found=1 }
		found { print }
		found && NF==0 { exit }
	')
	local row referenced_branches=""
	while IFS= read -r row; do
		[ -n "$row" ] || continue
		case "$row" in
		'| Feature'* | '|---'*) continue ;;
		esac
		if [[ "$row" =~ \`(rc/[A-Za-z0-9_-]+)\` ]]; then
			local rc_branch="${BASH_REMATCH[1]}"
			referenced_branches="${referenced_branches:+$referenced_branches }$rc_branch"
			if [[ ! "$row" =~ Incubating\ on\ \`$rc_branch\` ]]; then
				echo "WARN (c): README row for '$rc_branch' must say 'Incubating on \`$rc_branch\`' -- rc/* rows stay incubating until merged upstream."
				ok_c=0
			fi
			if branch_exists "$rc_branch" && [ "$(git rev-list --count "upstream/main..$rc_branch" 2>/dev/null || echo 0)" -eq 0 ]; then
				echo "WARN (c): README row for '$rc_branch' looks stale (no unique commits vs upstream/main) -- drop it if the work is merged upstream."
				ok_c=0
			fi
		fi
	done <<<"$readme_table"
	for i in "${!B_NAME[@]}"; do
		branch="${B_NAME[$i]}"
		case "$branch" in rc/*) ;; *) continue ;; esac
		if [ "${B_AHEAD_MAIN[$i]}" != "?" ] && [ "${B_AHEAD_MAIN[$i]}" -gt 0 ]; then
			if [[ " $referenced_branches " != *" $branch "* ]]; then
				echo "WARN (c): $branch has ${B_AHEAD_MAIN[$i]} commit(s) not in main and no README differences-table row."
				ok_c=0
			fi
		fi
	done
	[ "$ok_c" -eq 1 ] && echo "PASS (c): README differences table matches branch reality."

	# (d) main contains every rc/*+fork/* change set (dogfood invariant).
	# This is deliberately patch-equivalence based, not tip-ancestry based.
	# rc/* branches must stay clean for upstream PRs, usually based on
	# upstream/main; merging fork main back into an rc/* branch pollutes the
	# upstream PR with fork-only history.
	local ok_d=1
	for i in "${!B_NAME[@]}"; do
		branch="${B_NAME[$i]}"
		if ! patch_reaches_main "$branch"; then
			echo "WARN (d): '$branch' has patches not present in origin/main (dogfood invariant broken)."
			ok_d=0
		fi
	done
	[ "$ok_d" -eq 1 ] && echo "PASS (d): main contains every rc/*+fork/* change set."

	# (e) fork/omnicode-identity not behind main on docs files (best-effort).
	if branch_exists "fork/omnicode-identity"; then
		if git diff --quiet "origin/main:README.md" "fork/omnicode-identity:README.md" 2>/dev/null; then
			echo "PASS (e): fork/omnicode-identity README.md matches main."
		else
			echo "WARN (e): fork/omnicode-identity README.md differs from main -- may be behind (best-effort check)."
		fi
	else
		echo "WARN (e): fork/omnicode-identity branch not found locally -- skipped."
	fi

	# (f) fork main behind upstream/main -- freshly-rebased branches WILL
	# conflict on ship until the merged ritual / sync brings main forward.
	local behind_upstream
	behind_upstream=$(git rev-list --count "origin/main..upstream/main" 2>/dev/null || echo "?")
	if [ "$behind_upstream" = "?" ]; then
		echo "WARN (f): could not compare origin/main..upstream/main."
	elif [ "$behind_upstream" -gt 0 ]; then
		echo "WARN (f): fork main is behind upstream/main by $behind_upstream commit(s) -- ships of freshly-rebased branches will conflict; run the merged ritual / sync main."
	else
		echo "PASS (f): fork main contains upstream/main."
	fi

	# (g) dep/<branch>/on/<required> tags: SATISFIED requires a pr-<num>-merged
	# tag reachable from <required>; WARN if <required> no longer exists
	# locally (stale tag).
	local ok_g=1 dep_tag dep_branch dep_required
	for dep_tag in $(git tag -l 'dep/*/on/*' | sort); do
		# dep/<branch>/on/<required> -- branch/required may themselves contain
		# slashes (e.g. rc/foo), so split on the literal '/on/' separator.
		dep_branch="${dep_tag#dep/}"
		dep_branch="${dep_branch%/on/*}"
		dep_required="${dep_tag##*/on/}"
		if ! branch_exists "$dep_required"; then
			echo "WARN (g): tag '$dep_tag' references branch '$dep_required' which no longer exists locally (stale tag)."
			ok_g=0
			continue
		fi
		local dep_satisfied=0 mt
		for mt in $(git tag -l 'pr-*-merged'); do
			if tag_reaches "$mt" "$dep_required"; then
				dep_satisfied=1
				break
			fi
		done
		if [ "$dep_satisfied" -eq 1 ]; then
			echo "SATISFIED (g): $dep_branch requires $dep_required."
		else
			echo "UNSATISFIED (g): $dep_branch requires $dep_required."
			ok_g=0
		fi
	done
	[ "$ok_g" -eq 1 ] && echo "PASS (g): every dep/* tag is satisfied (or none exist)."

	echo "==============================================================="
}

# ---------------------------------------------------------------------------
# ship <branch>
# ---------------------------------------------------------------------------

cmd_ship() {
	local branch="$1"
	require_tooling

	log "Preflight for ship '$branch' -> main"
	require_branch "$branch"

	git fetch origin --quiet
	git fetch upstream --quiet

	git rev-parse --verify --quiet "origin/$branch" >/dev/null \
		|| die "branch '$branch' is not pushed to origin."
	[ "$(git rev-parse "$branch")" = "$(git rev-parse "origin/$branch")" ] \
		|| die "branch '$branch' has diverged from origin/$branch -- push or reconcile first."

	require_clean_main

	# Gate: the branch must not be based on upstream/main commits that fork
	# main doesn't have yet (a branch freshly rebased onto an upstream tip --
	# e.g. after an upstream squash-merge -- lands its whole upstream
	# foundation in the PR diff and conflicts against fork main). Practical
	# check: the branch's merge-base with upstream/main must already be inside
	# origin/main.
	log "Gate: branch base is contained in fork main"
	local mb
	mb=$(git merge-base "$branch" upstream/main) \
		|| die "no merge-base between '$branch' and upstream/main -- unrelated histories?"
	if ! git merge-base --is-ancestor "$mb" origin/main; then
		echo "    merge-base($branch, upstream/main) = $(git rev-parse --short "$mb") is NOT in origin/main."
		die "branch is based on upstream commits fork main doesn't have -- run 'fork-flow.sh merged <pr>' (or sync main from upstream) first, then ship."
	fi
	echo "    OK: branch base $(git rev-parse --short "$mb") is in origin/main."

	if patch_reaches_main "$branch"; then
		echo "    OK: '$branch' changes are already present in origin/main."
		update_main_checkout
		return 0
	fi

	# Gate: cheap mergeability probe BEFORE any PR exists. Modern git
	# (>= 2.38): 'merge-tree --write-tree' exits 1 on conflicts and, with
	# --name-only, lists conflicted paths after the tree OID. Older git falls
	# back to the three-arg merge-tree and greps for conflict markers.
	log "Gate: mergeability probe (origin/main <- $branch)"
	local probe_out probe_rc=0
	probe_out=$(git merge-tree --write-tree --name-only origin/main "$branch" 2>/dev/null) || probe_rc=$?
	if [ "$probe_rc" -gt 1 ]; then
		# --write-tree unsupported -> legacy three-arg form.
		probe_rc=0
		probe_out=$(git merge-tree "$mb" origin/main "$branch" 2>/dev/null || true)
		if grep -q '^+<<<<<<<' <<<"$probe_out" || grep -q '^changed in both' <<<"$probe_out"; then
			probe_rc=1
			probe_out="(legacy probe)"$'\n'"$(grep -A2 '^changed in both' <<<"$probe_out" | grep -oP '(?<=^  their +[0-9]+ [0-9a-f]{7,} ).*' | sort -u || true)"
		fi
	fi
	if [ "$probe_rc" -eq 1 ]; then
		echo "    merging '$branch' into origin/main would CONFLICT in:"
		# --name-only output: tree OID, conflicted paths, blank line, then
		# informational messages -- print only the paths.
		awk 'NR>1 { if ($0=="") exit; print "      " $0 }' <<<"$probe_out"
		die "mergeability probe failed -- resolve the conflict (or sync main) BEFORE any PR is created. No PR was created."
	fi
	echo "    OK: '$branch' merges cleanly into origin/main."

	local title body
	title="ship: ${branch#*/}"
	body="Merges \`$branch\` into fork \`main\`."

	confirm "Create fork PR ($FORK_REPO): $branch -> main?" || {
		echo "Aborted -- no PR created."
		return 0
	}

	log "Creating fork PR ($FORK_REPO): $branch -> main"
	local pr_url pr_num
	if [ "$DRY_RUN" -eq 1 ]; then
		run gh pr create -R "$FORK_REPO" --base main --head "$branch" --title "$title" --body "$body"
		pr_url="(dry-run, no PR created)"
		pr_num="DRYRUN"
	else
		pr_url=$(gh pr create -R "$FORK_REPO" --base main --head "$branch" --title "$title" --body "$body")
		pr_num="${pr_url##*/}"
	fi
	echo "PR: $pr_url"

	confirm "Merge PR #$pr_num into main now (--merge, keep branch)?" || {
		echo "Aborted before merge -- PR left open."
		return 0
	}

	run gh pr merge "$pr_num" -R "$FORK_REPO" --merge

	update_main_checkout
}

# ---------------------------------------------------------------------------
# upstream <rc-branch>
# ---------------------------------------------------------------------------

cmd_upstream() {
	local branch="$1"
	require_tooling
	require_branch "$branch"

	git fetch upstream --quiet
	git fetch origin --quiet

	log "Gate 1/7: branch based on current upstream/main tip"
	local behind
	behind=$(git rev-list --count "$branch..upstream/main")
	if [ "$behind" -gt 0 ]; then
		echo "    '$branch' is $behind commit(s) behind upstream/main."
		if confirm "Rebase via scripts/update-fork-branches.sh now?"; then
			run bash "$REPO_ROOT/scripts/update-fork-branches.sh"
			if [ "$DRY_RUN" -eq 0 ]; then
				git fetch origin --quiet
				git branch -f "$branch" "origin/$branch" 2>/dev/null || true
				behind=$(git rev-list --count "$branch..upstream/main")
				[ "$behind" -eq 0 ] || die "'$branch' is still $behind commit(s) behind upstream/main after rebase attempt."
			fi
		else
			die "'$branch' is behind upstream/main -- rebase before opening the PR."
		fi
	fi
	echo "    OK: '$branch' is current with upstream/main."

	log "Gate 2/7: no fork-main foundation / no fork-identity commits"
	# (2a) structural: clean rc branches are LINEAR on upstream/main. A branch
	# built on (stale or current) fork-main history inevitably carries
	# fork-main's ship-merge commits in its unique set. Tip-ancestry against
	# origin/main is NOT used -- it is unsound both ways (misses stale-history
	# contamination; false-positives on shipped rc branches whose commits are
	# in origin/main via the ship merge).
	local merge_count
	merge_count=$(git rev-list --merges --count "$branch" ^upstream/main)
	if [ "$merge_count" -gt 0 ]; then
		echo "    merge commit(s) in '$branch' history not in upstream/main:"
		git log --merges --format='      %h %s' -5 "$branch" ^upstream/main
		die "'$branch' is built on fork-main history ($merge_count merge commit(s)) -- rebase onto upstream/main before sending upstream."
	fi
	# (2b) commit-set intersection: the branch's unique commits must share
	# nothing with the fork-identity lineage (identity refs ^upstream/main,
	# minus commits reachable from local rc/* branches -- shipped rc commits
	# legitimately appear inside stale identity snapshots and are not
	# contamination).
	local -a identity_refs=() rc_excludes=()
	local r
	for r in "origin/fork/omnicode-identity" "origin/fork/omnicode-theme" "fork/omnicode-identity" "fork/omnicode-theme"; do
		if git rev-parse --verify --quiet "$r" >/dev/null; then
			identity_refs+=("$r")
		fi
	done
	while IFS= read -r r; do
		[ -n "$r" ] && rc_excludes+=("^$r")
	done < <(git for-each-ref --format='%(refname:short)' 'refs/heads/rc/*')
	if [ "${#identity_refs[@]}" -eq 0 ]; then
		warn "no fork-identity refs found locally or on origin -- skipping the commit-set intersection check."
	else
		local contaminated
		contaminated=$(comm -12 \
			<(git rev-list "$branch" ^upstream/main | sort) \
			<(git rev-list "${identity_refs[@]}" ^upstream/main "${rc_excludes[@]}" | sort))
		if [ -n "$contaminated" ]; then
			echo "    fork-identity commit(s) found on '$branch':"
			while IFS= read -r r; do
				[ -n "$r" ] && git log --no-walk --format='      %h %s' "$r"
			done <<<"$(head -5 <<<"$contaminated")"
			die "'$branch' carries fork-identity commits -- not safe to send upstream."
		fi
	fi
	echo "    OK: no fork-main merges, no fork-identity commits on '$branch'."

	log "Gate 3/7: no AI-attribution in commit messages"
	local msgs
	msgs=$(git log --format=%B "upstream/main..$branch")
	if grep -qiE 'co-authored-by|claude|ai-generated' <<<"$msgs"; then
		die "a commit on '$branch' mentions AI attribution (Co-Authored-By / Claude / AI-generated) -- clean up history first."
	fi
	echo "    OK: no AI-attribution strings found."

	log "Gate 4/7: fork-identity file heuristic (warn-only)"
	local identity_diff
	identity_diff=$(git diff "upstream/main..$branch" -- README.md CLAUDE.md source/config/themes.json 2>/dev/null || true)
	if [ -n "$identity_diff" ] && grep -qi omnicode <<<"$identity_diff"; then
		warn "diff touches README.md/CLAUDE.md/themes.json with 'omnicode' mentions -- verify these are not fork-identity leaks:"
		grep -in omnicode <<<"$identity_diff" | sed 's/^/    /' || true
	else
		echo "    OK: no fork-identity file hits."
	fi

	log "Gate 5/7: grep full diff for 'omnicode' (warn-only)"
	local full_diff hits
	full_diff=$(git diff "upstream/main..$branch")
	hits=$(grep -in omnicode <<<"$full_diff" || true)
	if [ -n "$hits" ]; then
		warn "'omnicode' found in diff (some may be legit, e.g. comments referencing the fork name):"
		echo "    ${hits//$'\n'/$'\n'    }"
	else
		echo "    OK: no 'omnicode' mentions in diff."
	fi

	log "Gate 6/7: dep/$branch/on/* tags are satisfied"
	local dep_tag required unsatisfied=0
	for dep_tag in $(git tag -l "dep/$branch/on/*"); do
		required="${dep_tag#dep/"$branch"/on/}"
		if ! branch_exists "$required"; then
			warn "dep tag '$dep_tag' references branch '$required' which no longer exists locally -- treating as unsatisfied."
			unsatisfied=1
			continue
		fi
		local satisfied=0 mt
		for mt in $(git tag -l 'pr-*-merged'); do
			if tag_reaches "$mt" "$required"; then
				satisfied=1
				break
			fi
		done
		if [ "$satisfied" -eq 1 ]; then
			echo "    OK: '$required' is released upstream (satisfies $dep_tag)."
		else
			echo "    '$required' has no pr-<num>-merged tag reachable from it."
			unsatisfied=1
		fi
	done
	if [ "$unsatisfied" -eq 1 ]; then
		die "'$branch' has an unsatisfied dependency (see dep/$branch/on/* tags above) -- release the required branch first: $0 upstream $required"
	fi
	echo "    OK: all dep/$branch/on/* tags satisfied (or none exist)."

	log "Gate 7/7: build + test:types in a temp worktree"
	TEMP_WORKTREE="$(mktemp -d)"
	git worktree add --force "$TEMP_WORKTREE" "$branch" >/dev/null 2>&1 \
		|| die "failed to create worktree for '$branch'."
	if [ "$DRY_RUN" -eq 1 ]; then
		echo "[dry-run] (cd $TEMP_WORKTREE && pnpm install --prefer-offline && pnpm run build && pnpm run test:types)"
	else
		if ! (
			cd "$TEMP_WORKTREE" &&
				pnpm install --prefer-offline &&
				pnpm run build &&
				pnpm run test:types
		) >"/tmp/fork-flow-upstream-checks.$$.log" 2>&1; then
			die "build/test:types FAILED for '$branch' (log: /tmp/fork-flow-upstream-checks.$$.log)"
		fi
		rm -f "/tmp/fork-flow-upstream-checks.$$.log"
	fi
	cleanup_temp_worktree
	echo "    OK: build + test:types passed."

	[ -n "$BODY_FILE" ] || die_usage "missing --body-file <f> (required -- the PR body is human/AI-written prose, this script never generates it). Template hint: .github/pull_request_template.md"
	[ -f "$BODY_FILE" ] || die "body file '$BODY_FILE' does not exist."

	local title
	title=$(git log --reverse --format=%s "upstream/main..$branch" | head -1)
	[ -n "$title" ] || title="$branch"

	echo ""
	echo "Ready to open upstream PR:"
	echo "    repo:   $UPSTREAM_REPO"
	echo "    head:   $FORK_HEAD_PREFIX:$branch"
	echo "    title:  $title"
	echo "    body:   $BODY_FILE"
	confirm "Create this upstream PR now?" || {
		echo "Aborted before creating PR."
		return 0
	}

	local pr_url pr_num
	if [ "$DRY_RUN" -eq 1 ]; then
		run gh pr create -R "$UPSTREAM_REPO" --head "$FORK_HEAD_PREFIX:$branch" --title "$title" --body-file "$BODY_FILE"
		pr_url="(dry-run, no PR created)"
		pr_num="DRYRUN"
	else
		pr_url=$(gh pr create -R "$UPSTREAM_REPO" --head "$FORK_HEAD_PREFIX:$branch" --title "$title" --body-file "$BODY_FILE")
		pr_num="${pr_url##*/}"
	fi
	echo "PR: $pr_url"

	run git tag "pr-$pr_num" "$branch"
	run git push origin "pr-$pr_num"
	echo "Tagged '$branch' as pr-$pr_num and pushed the tag."
}

# ---------------------------------------------------------------------------
# merged <pr-num>
# ---------------------------------------------------------------------------

cmd_merged() {
	local pr_num="$1"
	require_tooling
	[[ "$pr_num" =~ ^[0-9]+$ ]] || die_usage "merged expects a numeric PR number, got '$pr_num'."

	log "Resolving PR #$pr_num on $UPSTREAM_REPO"
	local pr_json state branch
	pr_json=$(gh pr view "$pr_num" -R "$UPSTREAM_REPO" --json state,headRefName 2>&1) \
		|| die "could not look up PR #$pr_num on $UPSTREAM_REPO: $pr_json"
	state=$(jq -r .state <<<"$pr_json")
	branch=$(jq -r .headRefName <<<"$pr_json")
	[ "$state" = "MERGED" ] || die "PR #$pr_num is '$state', not MERGED."
	branch_exists "$branch" || die "resolved branch '$branch' not found locally -- fetch it first."
	echo "    PR #$pr_num -> branch '$branch'."

	local old_tag="pr-$pr_num" new_tag="pr-$pr_num-merged"
	git rev-parse --verify --quiet "$old_tag" >/dev/null || die "tag '$old_tag' not found -- was this PR opened via 'fork-flow.sh upstream'?"

	require_clean_main

	confirm "Retag '$new_tag', merge upstream/main into fork main, push, and rebuild?" || {
		echo "Aborted -- nothing changed."
		return 0
	}

	if git rev-parse --verify --quiet "$new_tag" >/dev/null; then
		echo "    Tag '$new_tag' already exists, leaving it."
	else
		run git tag "$new_tag" "$old_tag"
		run git push origin "$new_tag"
		echo "    Tagged '$new_tag' (kept '$old_tag') and pushed."
	fi

	log "Fetching upstream and merging upstream/main into fork main"
	run git fetch upstream --quiet

	TEMP_WORKTREE="$(mktemp -d)"
	if [ "$DRY_RUN" -eq 1 ]; then
		echo "[dry-run] git worktree add --force $TEMP_WORKTREE main"
		echo "[dry-run] (cd $TEMP_WORKTREE && git merge upstream/main)"
		echo "[dry-run] git -C $TEMP_WORKTREE push origin main"
	else
		git worktree add --force "$TEMP_WORKTREE" main >/dev/null 2>&1 \
			|| die "failed to create worktree for 'main'."
		if ! git -C "$TEMP_WORKTREE" merge --no-edit upstream/main >/dev/null 2>&1; then
			git -C "$TEMP_WORKTREE" merge --abort >/dev/null 2>&1 || true
			die "merge conflict bringing upstream/main into main -- resolve manually in a worktree on 'main', do not let this script guess."
		fi
		git -C "$TEMP_WORKTREE" push origin main
	fi
	cleanup_temp_worktree

	update_main_checkout

	echo ""
	echo "REMINDER: drop the README differences-table row for this feature"
	echo "(docs PR to main + cherry-pick onto fork/omnicode-identity)."
}

# ---------------------------------------------------------------------------
# depend <branch> <required-branch>
# ---------------------------------------------------------------------------

cmd_depend() {
	local branch="$1" required="$2"
	require_tooling
	require_branch "$branch"
	require_branch "$required"

	[ "$branch" != "$required" ] || die "a branch cannot depend on itself ('$branch')."

	local tag="dep/$branch/on/$required"
	git rev-parse --verify --quiet "$tag" >/dev/null \
		&& die "tag '$tag' already exists -- run 'undepend $branch $required' first if you mean to re-point it."

	log "Tagging dependency: '$branch' requires '$required' released first"
	run git tag "$tag" "$branch"
	run git push origin "$tag"
	echo "Tagged '$tag' (at $(git rev-parse --short "$branch")) and pushed."
}

# ---------------------------------------------------------------------------
# undepend <branch> <required-branch>
# ---------------------------------------------------------------------------

cmd_undepend() {
	local branch="$1" required="$2"
	require_tooling
	require_branch "$branch"
	require_branch "$required"

	local tag="dep/$branch/on/$required"
	git rev-parse --verify --quiet "$tag" >/dev/null \
		|| die "tag '$tag' does not exist locally."

	confirm "Delete tag '$tag' locally and on origin?" || {
		echo "Aborted -- nothing changed."
		return 0
	}

	run git tag -d "$tag"
	if git ls-remote --exit-code --tags origin "$tag" >/dev/null 2>&1; then
		run git push origin ":refs/tags/$tag"
	else
		echo "    tag '$tag' not on origin -- nothing to push-delete."
	fi
	echo "Removed '$tag'."
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

case "$CMD" in
	status)
		cmd_status
		;;
	ship)
		[ -n "$ARG1" ] || die_usage "ship requires <branch>."
		cmd_ship "$ARG1"
		;;
	upstream)
		[ -n "$ARG1" ] || die_usage "upstream requires <rc-branch> (plus --body-file <f>)."
		cmd_upstream "$ARG1"
		;;
	merged)
		[ -n "$ARG1" ] || die_usage "merged requires <pr-num>."
		cmd_merged "$ARG1"
		;;
	depend)
		[ -n "$ARG1" ] && [ -n "$ARG2" ] || die_usage "depend requires <branch> <required-branch>."
		cmd_depend "$ARG1" "$ARG2"
		;;
	undepend)
		[ -n "$ARG1" ] && [ -n "$ARG2" ] || die_usage "undepend requires <branch> <required-branch>."
		cmd_undepend "$ARG1" "$ARG2"
		;;
	help)
		print_help "$ARG1"
		;;
	*)
		echo "Unknown subcommand: $CMD" >&2
		usage_line >&2
		echo "Run '$0 help' for details." >&2
		exit 2
		;;
esac
