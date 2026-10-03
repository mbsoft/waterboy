#!/bin/bash
# Fails if any commit in the range credits an AI assistant or uses an agent's name as author:
#   scripts/check-attribution.sh origin/main..HEAD
# Checks commit authors/committers and messages (Co-authored-by trailers, "Generated with Claude Code").
set -euo pipefail
range="${1:?usage: check-attribution.sh <rev-range>}"
AGENTS='claudia-PM|cliff-DEV|clarence-QA|clovis-DEVOPS|cleopatra-MKTG'
bad=0
while IFS= read -r sha; do
  [ -n "$sha" ] || continue
  who=$(git log -1 --format='%an <%ae>|%cn <%ce>' "$sha")
  msg=$(git log -1 --format='%B' "$sha")
  if grep -qiE "^co-authored-by:.*(claude|anthropic\.com)|generated with \[?claude code" <<< "$msg"; then
    echo "::error::$(git log -1 --format='%h %s' "$sha"): message credits Claude (Co-authored-by / Generated with Claude Code)"
    bad=1
  fi
  if grep -qiE "(^|[^a-z])($AGENTS)([^a-z]|$)|anthropic\.com" <<< "$who"; then
    echo "::error::$(git log -1 --format='%h %s' "$sha"): author/committer is an agent name ($who)"
    bad=1
  fi
done < <(git rev-list "$range")
[ "$bad" -eq 0 ] && echo "No AI attribution in $range."
exit "$bad"
