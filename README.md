# Play198x Website

Landing page for Play198x — a retro media player that runs entirely in the
visitor's browser. The site ships no media of its own: no sample module, no
screenshot. The visitor supplies their own file, and nothing leaves their
browser.

The site is built with Astro, on the shared `198x-ui` kit pinned at `v0.3.1`
and fetched into a gitignored `_198x-ui/` (see `scripts/fetch-ui.sh`).

```sh
npm ci
npm run build
npx astro preview
```
