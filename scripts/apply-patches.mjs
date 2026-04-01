#!/usr/bin/env node

/**
 * Apply patches to node_modules manually.
 *
 * This script is an opt-in maintainer utility, not part of install-time
 * behavior. It exists so we can verify or reapply the upstream patch locally
 * when needed.
 *
 * See: https://github.com/badlogic/pi-mono/issues/XXX
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const patchDir = resolve(root, "patches");
const targetDir = resolve(root, "node_modules/@mariozechner/pi-coding-agent");

const patches = ["extension-error-event.patch"];

for (const patch of patches) {
  const patchPath = resolve(patchDir, patch);
  if (!existsSync(patchPath)) {
    console.warn(`⚠ Patch not found: ${patch}`);
    continue;
  }
  if (!existsSync(targetDir)) {
    console.warn(`⚠ Target not found: ${targetDir}`);
    continue;
  }

  try {
    // Check if patch can be applied (fails if already applied or conflicts)
    execSync(`patch -p1 --dry-run --forward < "${patchPath}"`, {
      cwd: targetDir,
      stdio: "pipe",
    });
    // Dry run succeeded — apply for real
    execSync(`patch -p1 --forward < "${patchPath}"`, {
      cwd: targetDir,
      stdio: "pipe",
    });
    console.log(`✓ ${patch} (applied)`);
  } catch {
    // Forward dry-run failed — either already applied or incompatible.
    // Check if reverse applies cleanly (= already patched).
    try {
      execSync(`patch -p1 --dry-run --reverse < "${patchPath}"`, {
        cwd: targetDir,
        stdio: "pipe",
      });
      console.log(`✓ ${patch} (already applied)`);
    } catch {
      console.error(`✗ ${patch} failed — patch may be incompatible with this version`);
      process.exit(1);
    }
  }
}
