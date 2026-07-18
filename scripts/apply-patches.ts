#!/usr/bin/env bun
/**
 * In-repo replacement for package.json#patchedDependencies.
 *
 * Bun cannot apply a git-dependency's own patchedDependencies (it resolves the
 * patch path against the CONSUMER project and hard-fails the whole install),
 * which made `@genesiscz/tools` uninstallable as a git dep. So the field is
 * gone and this script applies the same patches from the root postinstall —
 * which only runs for THIS repo (dependency lifecycle scripts are blocked by
 * default for consumers, so they install clean and unpatched: the cli-table3
 * interop guard is redundant under a correctly-resolved string-width@4, and
 * the @opentui/solid patch is types-only).
 */
import { existsSync, realpathSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";

const PATCHES: Array<{ pkg: string; patch: string }> = [
    { pkg: "node_modules/cli-table3", patch: "patches/cli-table3@0.6.5.patch" },
    { pkg: "node_modules/@opentui/solid", patch: "patches/@opentui%2Fsolid@0.1.100.patch" },
];

async function gitApply(args: string[]): Promise<number> {
    const proc = Bun.spawn(["git", "apply", ...args], { stdout: "ignore", stderr: "ignore" });
    return await proc.exited;
}

let failed = false;
for (const { pkg: pkgPath, patch } of PATCHES) {
    if (!existsSync(pkgPath)) {
        logger.debug({ pkg: pkgPath }, "apply-patches: package not installed, skipping");
        continue;
    }

    // git apply refuses paths "beyond a symbolic link" (worktrees often symlink
    // node_modules to the main checkout) — resolve to the real directory first.
    const pkg = realpathSync(pkgPath);

    if ((await gitApply(["--reverse", "--check", `--directory=${pkg}`, "--unsafe-paths", patch])) === 0) {
        continue;
    }

    if ((await gitApply(["--check", `--directory=${pkg}`, "--unsafe-paths", patch])) !== 0) {
        console.error(
            `apply-patches: ${patch} applies neither forward nor reverse against ${pkg} — package version drift?`
        );
        failed = true;
        continue;
    }

    if ((await gitApply([`--directory=${pkg}`, "--unsafe-paths", patch])) !== 0) {
        console.error(`apply-patches: failed to apply ${patch} to ${pkg}`);
        failed = true;
        continue;
    }

    console.log(`apply-patches: applied ${patch} -> ${pkg}`);
}

process.exit(failed ? 1 : 0);
