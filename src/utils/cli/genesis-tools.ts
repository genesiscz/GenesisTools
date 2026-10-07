import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";

/**
 * Where the GenesisTools `tools` CLI is installed, for code that prints or runs a `tools …` command
 * from outside the GenesisTools process (a vendored copy in another repo, a generated script).
 */

export interface GenesisToolsHandle {
    /** Absolute path of the `tools` executable. */
    binPath: string;
}

export interface DetectProbes {
    /** The working directory to look for a GenesisTools checkout from; without it that step is skipped. */
    cwd?(): string;
    which(cmd: string): string | null;
    /** Checkout roots to try in order: `GENESIS_TOOLS_PATH`, then `GENESIS_TOOLS_ROOT`. */
    roots(): Array<string | undefined>;
    exists(path: string): boolean;
}

export const defaultDetectProbes: DetectProbes = {
    cwd: () => process.cwd(),
    which: (cmd) => Bun.which(cmd),
    roots: () => [env.tools.getPath(), env.tools.getRoot()],
    exists: (path) => existsSync(path),
};

let cached: GenesisToolsHandle | null | undefined;

export function resetGenesisToolsCache(): void {
    cached = undefined;
}

/** A file only a GenesisTools checkout has, beside its `tools`: a folder that merely holds some `tools` does not count. */
const CHECKOUT_MARKER = join("src", "utils", "cli", "genesis-tools.ts");

/**
 * The GenesisTools checkout (main or a git worktree) that holds `from`, walking up to the filesystem
 * root; null outside one.
 */
export function genesisToolsCheckout(from: string, exists: (path: string) => boolean = existsSync): string | null {
    let dir = resolve(from);

    while (true) {
        if (exists(join(dir, "tools")) && exists(join(dir, CHECKOUT_MARKER))) {
            return dir;
        }

        const parent = dirname(dir);

        if (parent === dir) {
            return null;
        }

        dir = parent;
    }
}

/**
 * The `tools` to run, in this order:
 * 1. the checkout the working directory is in, a git worktree included, so a command run inside a
 *    worktree runs that worktree's code and never silently the main checkout's;
 * 2. `<GENESIS_TOOLS_PATH>/tools`, then `<GENESIS_TOOLS_ROOT>/tools`: an explicit setting;
 * 3. `tools` on PATH last: ambient, and it always names the main checkout (`install.sh`), which is
 *    exactly the mix-up step 1 prevents. An explicit variable outranks it for the same reason.
 * Cached per process: a command's working directory does not change while it runs.
 */
export function detectGenesisTools(probes: DetectProbes = defaultDetectProbes): GenesisToolsHandle | null {
    if (cached !== undefined) {
        return cached;
    }

    const from = probes.cwd?.();
    const checkout = from ? genesisToolsCheckout(from, probes.exists) : null;

    if (checkout) {
        cached = { binPath: join(checkout, "tools") };

        return cached;
    }

    for (const root of probes.roots()) {
        const trimmed = root?.trim();
        if (!trimmed) {
            continue;
        }

        const bin = join(resolve(trimmed), "tools");
        if (probes.exists(bin)) {
            cached = { binPath: bin };

            return cached;
        }
    }

    const onPath = probes.which("tools");
    if (onPath) {
        cached = { binPath: onPath };

        return cached;
    }

    cached = null;

    return null;
}
