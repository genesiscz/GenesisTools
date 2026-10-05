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
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export interface PatchEntry {
    pkg: string;
    patch: string;
    /** The upstream release that ships the fix: from it on the patch is skipped, not failed as version drift. */
    fixedIn?: string;
}

export const PATCHES: PatchEntry[] = [
    { pkg: "node_modules/cli-table3", patch: "patches/cli-table3@0.6.5.patch" },
    { pkg: "node_modules/@opentui/solid", patch: "patches/@opentui%2Fsolid@0.5.9.patch" },
    // A spinner whose output is not a terminal prints one line per message (clack's CI mode) instead of
    // an animation frame every 80 ms that floods logs and agent output.
    { pkg: "node_modules/@clack/prompts", patch: "patches/@clack%2Fprompts@1.7.0.patch" },
    // Upstream fix for server.close() hanging on a mid-optimize dep; drop at vite >= 8.3.1.
    { pkg: "node_modules/vite", patch: "patches/vite@8.2.2.patch", fixedIn: "8.3.1" },
];

/** True when the installed version already ships the fix the patch carries. */
export function fixedUpstream(entry: PatchEntry, installed: string | null): boolean {
    return Boolean(entry.fixedIn && installed && Bun.semver.satisfies(installed, `>=${entry.fixedIn}`));
}

function installedVersion(pkg: string): string | null {
    try {
        const manifest: unknown = SafeJSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
        return typeof manifest === "object" &&
            manifest !== null &&
            "version" in manifest &&
            typeof manifest.version === "string"
            ? manifest.version
            : null;
    } catch (err) {
        logger.debug({ err, pkg }, "apply-patches: the installed version could not be read");
        return null;
    }
}

async function gitApply(args: string[]): Promise<number> {
    const proc = Bun.spawn(["git", "apply", ...args], { stdout: "ignore", stderr: "ignore" });
    return await proc.exited;
}

async function main(): Promise<void> {
    let failed = false;
    for (const entry of PATCHES) {
        const { pkg: pkgPath, patch } = entry;

        if (!existsSync(pkgPath)) {
            logger.debug({ pkg: pkgPath }, "apply-patches: package not installed, skipping");
            continue;
        }

        // git apply refuses paths "beyond a symbolic link" (worktrees often symlink
        // node_modules to the main checkout) — resolve to the real directory first.
        const pkg = realpathSync(pkgPath);
        const installed = installedVersion(pkg);

        if (fixedUpstream(entry, installed)) {
            logger.debug({ pkg, installed, fixedIn: entry.fixedIn }, "apply-patches: upstream ships the fix, skipping");
            console.log(
                `apply-patches: ${patch} is obsolete at ${installed} (fixed upstream in ${entry.fixedIn}); remove it`
            );
            continue;
        }

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
}

if (import.meta.main) {
    await main();
}
