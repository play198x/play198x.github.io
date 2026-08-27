#!/usr/bin/env node
// @play198x/web is a published npm dependency — the wasm is already built and
// published. This just stages its files where Astro serves them as static
// assets. No Rust, no wasm-pack, no play198x checkout enters this build.
import { cpSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const pkgJsonPath = pathToFileURL(require.resolve('@play198x/web/package.json'));
const pkgDir = new URL('.', pkgJsonPath);
const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
const dest = new URL('../public/wasm/', import.meta.url);

for (const file of pkg.files) {
  cpSync(new URL(file, pkgDir), new URL(file, dest));
}
