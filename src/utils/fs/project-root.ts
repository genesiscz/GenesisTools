import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Walk up from `from` to the enclosing git repo root (the directory holding
 * `.git`), or null when no ancestor has one. Shared by `tools todo` context
 * detection and the `tools scripts` journal (project inference + gating).
 */
export function findProjectRoot(from: string): string | null {
    let dir = resolve(from);

    while (true) {
        if (existsSync(resolve(dir, ".git"))) {
            return dir;
        }

        const parent = dirname(dir);

        if (parent === dir) {
            return null;
        }

        dir = parent;
    }
}
