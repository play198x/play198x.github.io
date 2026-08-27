#!/usr/bin/env bash
# Fetch the shared 198x-ui components into _198x-ui, at the pinned tag.
#
# CI checks the repo out with actions/checkout; this is the same thing for local
# work, so `npm run dev` does not need the workflow. Both write to _198x-ui,
# which is gitignored — the components are never vendored into this repo.
#
# Pinned deliberately. Tracking main would let a change in the shared repo break
# three sites at once with nothing in between to catch it.
set -euo pipefail

REPO="https://github.com/stevehill1981/198x-ui.git"
REF="${UI_REF:-v0.3.1}"
DIR="_198x-ui"

if [ -d "$DIR/.git" ]; then
  current=$(git -C "$DIR" describe --tags --exact-match 2>/dev/null || echo "")
  if [ "$current" = "$REF" ]; then
    echo "198x-ui: already at $REF"
    exit 0
  fi
  git -C "$DIR" fetch --quiet --tags origin
  git -C "$DIR" checkout --quiet "$REF"
  echo "198x-ui: moved to $REF"
else
  rm -rf "$DIR"
  git clone --quiet --depth 1 --branch "$REF" "$REPO" "$DIR"
  echo "198x-ui: cloned at $REF"
fi
