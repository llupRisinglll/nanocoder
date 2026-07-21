#!/usr/bin/env bash
set -euo pipefail

input=$(cat)

cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')
dirname=$(basename "${cwd:-.}")
user=$(whoami)
host=$(hostname -s 2>/dev/null || echo '')

CYAN='\033[0;36m'
BOLD_BLUE='\033[1;34m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
MAGENTA='\033[0;35m'
DIM='\033[2m'
RESET='\033[0m'

git_part=""
if [ -n "$cwd" ]; then
  git_branch=$(git -C "$cwd" -c core.fsync=none symbolic-ref --short HEAD 2>/dev/null || true)
  if [ -n "$git_branch" ]; then
    git_dirty=$(git -C "$cwd" -c core.fsync=none status --porcelain 2>/dev/null || true)
    if [ -n "$git_dirty" ]; then
      git_part="  ${BOLD_BLUE}git:(${RED}${git_branch}${BOLD_BLUE}) ${YELLOW}x${RESET}"
    else
      git_part="  ${BOLD_BLUE}git:(${RED}${git_branch}${BOLD_BLUE})${RESET}"
    fi
  fi
fi

model=$(echo "$input" | jq -r '.model.display_name // .model.id // empty')

tune_part=""
tune_enabled=$(echo "$input" | jq -r '.tune.enabled // false')
if [ "$tune_enabled" = "true" ]; then
  tune_profile=$(echo "$input" | jq -r '.tune.resolved_profile // .tune.profile // empty')
  tune_mode=$(echo "$input" | jq -r '.tune.tool_mode // empty')
  if [ -n "$tune_profile" ] && [ -n "$tune_mode" ]; then
    tune_part="${DIM}tune:${RESET}${CYAN}${tune_profile}/${tune_mode}${RESET}"
  elif [ -n "$tune_profile" ]; then
    tune_part="${DIM}tune:${RESET}${CYAN}${tune_profile}${RESET}"
  fi
fi

ctx_part=""
used_pct=$(echo "$input" | jq -r '.context.used_percent // .context_window.used_percentage // empty')
if [ -n "$used_pct" ] && [ "$used_pct" != "null" ]; then
  filled=$(echo "$used_pct" | awk '{printf "%d", ($1 / 10 + 0.5)}')
  [ "$filled" -gt 10 ] && filled=10
  [ "$filled" -lt 0 ] && filled=0
  empty=$((10 - filled))
  bar=""
  for _ in $(seq 1 "$filled"); do bar="${bar}▰"; done
  for _ in $(seq 1 "$empty"); do bar="${bar}▱"; done
  pct_int=$(printf "%.0f" "$used_pct")
  if [ "$pct_int" -ge 80 ]; then
    bar_color="$RED"
  elif [ "$pct_int" -ge 50 ]; then
    bar_color="$YELLOW"
  else
    bar_color="$GREEN"
  fi
  ctx_part="${DIM}ctx:${RESET}${bar_color}${bar}${RESET}${DIM} ${pct_int}%${RESET}"
fi

if [ -n "$host" ]; then
  left=$(printf "[${CYAN}%s@%s${RESET} ${CYAN}%s${RESET}]%b" "$user" "$host" "$dirname" "$git_part")
else
  left=$(printf "[${CYAN}%s${RESET} ${CYAN}%s${RESET}]%b" "$user" "$dirname" "$git_part")
fi

right_parts=()
[ -n "$model" ] && right_parts+=("${MAGENTA}${model}${RESET}")
[ -n "$tune_part" ] && right_parts+=("$tune_part")
[ -n "$ctx_part" ] && right_parts+=("$ctx_part")

printf '%b\n' "$left"
if [ "${#right_parts[@]}" -gt 0 ]; then
  joined="${right_parts[0]}"
  for part in "${right_parts[@]:1}"; do
    joined="${joined}  ${part}"
  done
  printf '%b' "$joined"
fi
