#!/usr/bin/env node
/**
 * Re-apply the FL dsn-converter patch after any `npm install`.
 *
 * The patched build (dsn-converter-index.PATCHED.js) gives per-pad-geometry
 * image names + inner-layer wire mapping, which is what lets freerouting route
 * dense multi-layer boards without phantom shorts. npm install overwrites
 * node_modules, so this runs as `postinstall` to restore it.
 *
 * Idempotent: if the target is already patched (contains flGeomSig), it does
 * nothing. Safe: if node_modules isn't laid out as expected (e.g. hoisted
 * elsewhere, or install ran with a different layout), it warns and exits 0 so
 * it NEVER fails the install.
 */
import { readFileSync, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PATCHED = join(HERE, "dsn-converter-index.PATCHED.js");
const TARGET = join(HERE, "..", "node_modules", "dsn-converter", "dist", "index.js");
// Keyed on the LATEST patch marker, so a node_modules that carries an older
// patch level is re-patched rather than mistaken for current.
const SENTINEL = "FL PATCH v2";

try {
  if (!existsSync(PATCHED)) {
    console.warn(`[fl-patch] patched source missing (${PATCHED}); skipping`);
    process.exit(0);
  }
  if (!existsSync(TARGET)) {
    console.warn(`[fl-patch] dsn-converter not found at ${TARGET}; skipping (node_modules layout differs)`);
    process.exit(0);
  }
  const current = readFileSync(TARGET, "utf8");
  if (current.includes(SENTINEL)) {
    console.log("[fl-patch] dsn-converter already patched — nothing to do");
    process.exit(0);
  }
  copyFileSync(PATCHED, TARGET);
  console.log("[fl-patch] restored patched dsn-converter");
} catch (err) {
  // Never fail the install over a patch we can retry with RESTORE.sh.
  console.warn(`[fl-patch] could not apply dsn-converter patch: ${err.message}; skipping`);
}
process.exit(0);
