import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The repository a path sits in (the nearest folder at or above it that holds a `.git`), or null. No git process. */
export function repoRootOf(path: string): string | null {
    let current = resolve(path);

    while (true) {
        if (existsSync(join(current, ".git"))) {
            return current;
        }

        const parent = dirname(current);

        if (parent === current) {
            return null;
        }

        current = parent;
    }
}
