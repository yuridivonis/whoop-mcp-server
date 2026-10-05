#!/usr/bin/env bash
# Files a live-check report as a GitHub issue: a comment on the open issue labelled
# live-check when there is one, a new issue otherwise. Needs gh with issues: write and
# GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID from the workflow.
#
#   scripts/live-check-issue.sh report.md
set -euo pipefail

report="$1"
label="live-check"
run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-}"

body="$(cat "$report")

Run: ${run_url}"

gh label create "$label" --repo "$GITHUB_REPOSITORY" --description "Opened by the weekly live check" --color D93F0B --force >/dev/null

existing="$(gh issue list --repo "$GITHUB_REPOSITORY" --label "$label" --state open --limit 1 --json number --jq '.[0].number // empty')"
if [ -n "$existing" ]; then
  gh issue comment "$existing" --repo "$GITHUB_REPOSITORY" --body "$body"
  echo "Added the report to issue #$existing."
else
  gh issue create --repo "$GITHUB_REPOSITORY" --label "$label" --title "Live check found a problem" --body "$body"
fi
