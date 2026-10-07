import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
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
    which(cmd: string): string | null;
    /** Checkout roots to try in order: `GENESIS_TOOLS_PATH`, then `GENESIS_TOOLS_ROOT`. */
    roots(): Array<string | undefined>;
    exists(path: string): boolean;
}

export const defaultDetectProbes: DetectProbes = {
    which: (cmd) => Bun.which(cmd),
    roots: () => [env.tools.getPath(), env.tools.getRoot()],
    exists: (path) => existsSync(path),
};

let cached: GenesisToolsHandle | null | undefined;

export function resetGenesisToolsCache(): void {
    cached = undefined;
}

/** `tools` on PATH, else `<GENESIS_TOOLS_PATH>/tools` or `<GENESIS_TOOLS_ROOT>/tools`. Cached per process. */
export function detectGenesisTools(probes: DetectProbes = defaultDetectProbes): GenesisToolsHandle | null {
    if (cached !== undefined) {
        return cached;
    }

    const onPath = probes.which("tools");
    if (onPath) {
        cached = { binPath: onPath };

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

    cached = null;

    return null;
}
