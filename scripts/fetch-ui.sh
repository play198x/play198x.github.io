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
REF="${UI_REF:-v0.5.0}"
DIR="_198x-ui"

if [ -d "$DIR/.git" ]; then
  current=$(git -C "$DIR" describe --tags --exact-match 2>/dev/null || echo "")
  if [ "$current" != "$REF" ]; then
    git -C "$DIR" fetch --quiet --tags origin
    git -C "$DIR" checkout --quiet "$REF"
    echo "198x-ui: moved to $REF"
  else
    echo "198x-ui: already at $REF"
  fi
else
  rm -rf "$DIR"
  git clone --quiet --depth 1 --branch "$REF" "$REPO" "$DIR"
  echo "198x-ui: cloned at $REF"
fi

# fonts.css asks for /fonts/, so the kit's font files have to be served from the
# site root. They belong to the kit rather than to this site, so public/fonts is
# gitignored and recopied on every run instead of being committed here.
#
# This runs unconditionally, including when the checkout was already at $REF.
# Copying it only on a version change would leave a cleaned public/ with no
# fonts and no error -- the page would silently fall back to system faces.
mkdir -p public
rm -rf public/fonts
cp -R "$DIR/fonts" public/fonts
echo "198x-ui: fonts copied to public/fonts"
