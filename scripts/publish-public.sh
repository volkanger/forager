#!/usr/bin/env bash
# Publishes the current commit of this (private) repo to the public volkanger/forager repo
# as a single new commit, without the private history.
set -euo pipefail

PUBLIC_REPO="${PUBLIC_REPO:-volkanger/forager}"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or stash your changes first." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

gh repo clone "$PUBLIC_REPO" "$WORK/public" -- --quiet
# Replace the public tree with this commit's tracked files.
find "$WORK/public" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git archive HEAD | tar -x -C "$WORK/public"

cd "$WORK/public"
git add -A
if git diff --cached --quiet; then
  echo "Public repo is already up to date."
  exit 0
fi
MESSAGE="${1:-Sync from private repo ($(git -C "$ROOT" rev-parse --short HEAD))}"
git commit --quiet -m "$MESSAGE"
git push --quiet
echo "Published to https://github.com/$PUBLIC_REPO"
