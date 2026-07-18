#!/usr/bin/env bash
#
# update-fork-branches.sh
#
# Rebases this fork's long-lived branches onto their upstream base branches,
# runs a build/type-check verification pass, and force-pushes the result
# (with --force-with-lease) if everything looks clean.
#
# Branch map:
#   - every local rc/*                -> rebase onto upstream/main
#   - fork/omnicode-identity           -> rebase onto upstream/main
#   - fork/omnicode-theme              -> rebase onto origin/main
#
# Skip rules (a branch is left alone and reported, never force-pushed):
#   1. The branch currently checked out in the main working dir (never touch it).
#   2. A branch whose tip commit is already reachable from a
#      'pr-<num>-merged' tag (i.e. that PR's merge commit is an ancestor of
#      the branch) -- the branch has nothing left to rebase, it already
#      landed upstream via that PR.
#   3. A branch that is already 0 commits behind its base (up to date).
#
# Per-branch flow:
#   1. Create a throwaway worktree (mktemp -d) checked out at the branch.
#   2. git rebase <base> in that worktree.
#      - On conflict: abort the rebase, mark NEEDS-MANUAL, move on. The
#        worktree is still removed -- we never leave a half-rebased worktree
#        lying around.
#   3. Unless --no-verify was passed, run the verification pipeline:
#        pnpm install --prefer-offline
#        pnpm run build
#        pnpm run test:types
#      Any failure marks the branch FAILED-CHECKS and skips the push.
#   4. Push the rebased branch back with --force-with-lease.
#   5. Always remove the temp worktree, success or failure.
#
# Usage:
#   scripts/update-fork-branches.sh [--no-verify]
#
#   --no-verify   Skip the pnpm install/build/test:types verification step
#                 after a successful rebase. Still pushes on success. Useful
#                 for a fast dry-ish run when you already know the branches
#                 are current and just want to exercise the skip/up-to-date
#                 logic without paying for a full install+build.
#
# Exit status: 0 always (per-branch failures are reported in the summary
# table, not fatal to the whole run), unless a genuine script bug occurs.

set -euo pipefail

# ---------------------------------------------------------------------------
# Config / argument parsing
# ---------------------------------------------------------------------------

NO_VERIFY=0
for arg in "$@"; do
	case "$arg" in
		--no-verify)
			NO_VERIFY=1
			;;
		*)
			echo "Unknown argument: $arg" >&2
			echo "Usage: $0 [--no-verify]" >&2
			exit 1
			;;
	esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Branch -> base remote-tracking ref this branch should be rebased onto.
# (bash 3.2 compatible: parallel arrays instead of an associative array.)
BRANCH_NAMES=()
BRANCH_BASES=()

add_branch() {
	local name="$1" base="$2"
	BRANCH_NAMES+=("$name")
	BRANCH_BASES+=("$base")
}

# Every local rc/* branch rebases onto upstream/main.
while IFS= read -r branch; do
	[ -n "$branch" ] || continue
	add_branch "$branch" "upstream/main"
done < <(git for-each-ref --format='%(refname:short)' 'refs/heads/rc/*')

add_branch "fork/omnicode-identity" "upstream/main"
add_branch "fork/omnicode-theme" "origin/main"

# ---------------------------------------------------------------------------
# Summary table accumulator
# ---------------------------------------------------------------------------

SUMMARY_BRANCH=()
SUMMARY_ACTION=()
SUMMARY_SHA=()

record() {
	SUMMARY_BRANCH+=("$1")
	SUMMARY_ACTION+=("$2")
	SUMMARY_SHA+=("$3")
}

# ---------------------------------------------------------------------------
# Fetch everything up front
# ---------------------------------------------------------------------------

echo "==> Fetching all remotes (origin, upstream)..."
git fetch --all --prune

# ---------------------------------------------------------------------------
# Detect the branch checked out in the main working dir -- never touch it.
#
# Note: this is deliberately the *main* nanocoder working dir, not
# $REPO_ROOT. This script itself normally runs from a worktree (per repo
# convention, rc/tui-screen-modes stays checked out in the main working dir
# and is never built there), so $REPO_ROOT != the main working dir most of
# the time. We must ask the main working dir directly what it has checked
# out so we never force-push over it.
# ---------------------------------------------------------------------------

MAIN_WORKDIR="/mnt/data/KSProjects/NanoCollective/nanocoder"
CHECKED_OUT_BRANCH="$(git -C "$MAIN_WORKDIR" branch --show-current || true)"
echo "==> Main working dir ($MAIN_WORKDIR) currently has '$CHECKED_OUT_BRANCH' checked out (will be skipped)."

# ---------------------------------------------------------------------------
# Helper: does a branch already have a matching pr-<num>-merged tag that is
# an ancestor of it? If so, it already landed upstream -- skip it.
# ---------------------------------------------------------------------------

merged_tag_for_branch() {
	local branch="$1" t
	for t in $(git tag -l 'pr-*-merged'); do
		if git merge-base --is-ancestor "$t" "$branch" 2>/dev/null; then
			echo "$t"
			return 0
		fi
	done
	return 1
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

for i in "${!BRANCH_NAMES[@]}"; do
	branch="${BRANCH_NAMES[$i]}"
	base="${BRANCH_BASES[$i]}"

	echo ""
	echo "==> Processing '$branch' (base: $base)"

	if ! git show-ref --verify --quiet "refs/heads/$branch"; then
		echo "    Local branch '$branch' does not exist, skipping."
		record "$branch" "skipped-missing" "-"
		continue
	fi

	if [ "$branch" = "$CHECKED_OUT_BRANCH" ]; then
		echo "    '$branch' is checked out in the main working dir -- never touching it."
		record "$branch" "SKIPPED-CHECKED-OUT" "$(git rev-parse --short "$branch")"
		continue
	fi

	if ! git rev-parse --verify --quiet "$base" >/dev/null; then
		echo "    Base ref '$base' not found, skipping."
		record "$branch" "skipped-missing-base" "-"
		continue
	fi

	# Skip rule: a pr-<num>-merged tag already contains this branch's tip.
	if merged_tag="$(merged_tag_for_branch "$branch")"; then
		echo "    Skipping: tag '$merged_tag' already contains this branch's tip commit (already merged upstream)."
		record "$branch" "skipped-merged ($merged_tag)" "$(git rev-parse --short "$branch")"
		continue
	fi

	# Skip rule: already 0 commits behind base.
	behind="$(git rev-list --count "$branch..$base")"
	if [ "$behind" -eq 0 ]; then
		echo "    Already up to date with $base (0 behind), skipping."
		record "$branch" "up-to-date" "$(git rev-parse --short "$branch")"
		continue
	fi

	echo "    $behind commit(s) behind $base -- rebasing in a temp worktree."

	worktree_dir="$(mktemp -d)"
	rebase_ok=1
	checks_ok=1

	# Always clean up the worktree, no matter how this iteration ends.
	cleanup_worktree() {
		git worktree remove --force "$worktree_dir" 2>/dev/null || true
		rm -rf "$worktree_dir"
	}
	trap cleanup_worktree EXIT

	if ! git worktree add --force "$worktree_dir" "$branch" >/dev/null 2>&1; then
		echo "    Failed to create worktree for '$branch', skipping."
		record "$branch" "needs-manual (worktree-add-failed)" "$(git rev-parse --short "$branch")"
		cleanup_worktree
		trap - EXIT
		continue
	fi

	if ! git -C "$worktree_dir" rebase "$base" >/dev/null 2>&1; then
		echo "    Rebase conflict on '$branch', aborting rebase."
		git -C "$worktree_dir" rebase --abort >/dev/null 2>&1 || true
		rebase_ok=0
	fi

	if [ "$rebase_ok" -eq 1 ]; then
		if [ "$NO_VERIFY" -eq 0 ]; then
			echo "    Running verification: pnpm install --prefer-offline && pnpm run build && pnpm run test:types"
			if ! (
				cd "$worktree_dir" &&
					pnpm install --prefer-offline &&
					pnpm run build &&
					pnpm run test:types
			) >/tmp/update-fork-branches-checks.$$.log 2>&1; then
				echo "    Verification FAILED for '$branch' (log: /tmp/update-fork-branches-checks.$$.log)"
				checks_ok=0
			else
				echo "    Verification passed."
			fi
			rm -f "/tmp/update-fork-branches-checks.$$.log" 2>/dev/null || true
		else
			echo "    --no-verify given, skipping build/typecheck."
		fi
	fi

	new_sha="$(git -C "$worktree_dir" rev-parse --short HEAD 2>/dev/null || git rev-parse --short "$branch")"

	if [ "$rebase_ok" -eq 0 ]; then
		record "$branch" "needs-manual" "$(git rev-parse --short "$branch")"
	elif [ "$checks_ok" -eq 0 ]; then
		record "$branch" "failed-checks" "$new_sha"
	else
		echo "    Pushing '$branch' to origin with --force-with-lease."
		if git -C "$worktree_dir" push --force-with-lease origin "HEAD:refs/heads/$branch"; then
			record "$branch" "updated" "$new_sha"
		else
			record "$branch" "needs-manual (push-failed)" "$new_sha"
		fi
	fi

	cleanup_worktree
	trap - EXIT
done

# Also report the checked-out branch explicitly if it wasn't part of the map
# above (e.g. someone has main or an unrelated branch checked out).
already_reported=0
for b in "${SUMMARY_BRANCH[@]}"; do
	if [ "$b" = "$CHECKED_OUT_BRANCH" ]; then
		already_reported=1
		break
	fi
done
if [ "$already_reported" -eq 0 ] && [ -n "$CHECKED_OUT_BRANCH" ]; then
	record "$CHECKED_OUT_BRANCH" "SKIPPED-CHECKED-OUT" "$(git rev-parse --short "$CHECKED_OUT_BRANCH" 2>/dev/null || echo '-')"
fi

# ---------------------------------------------------------------------------
# Summary table
# ---------------------------------------------------------------------------

echo ""
echo "==================== SUMMARY ===================="
printf '%-30s %-32s %-10s\n' "branch" "action" "new head sha"
printf '%-30s %-32s %-10s\n' "------------------------------" "--------------------------------" "----------"
for i in "${!SUMMARY_BRANCH[@]}"; do
	printf '%-30s %-32s %-10s\n' "${SUMMARY_BRANCH[$i]}" "${SUMMARY_ACTION[$i]}" "${SUMMARY_SHA[$i]}"
done
echo "==================================================="
