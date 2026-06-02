import { type Dirent, readdirSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * Recursively list files under `dir` whose extension is in `exts`, skipping any
 * path containing one of the `ignore` substrings. Returns absolute paths.
 */
export function listSourceFiles(dir: string, exts: string[], ignore: string[]): string[] {
    const suffixes = new Set(exts.map((e) => (e.startsWith(".") ? e : `.${e}`)));
    const out: string[] = [];

    const walk = (current: string): void => {
        let entries: Dirent[];
        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const full = join(current, entry.name);
            if (ignore.some((needle) => full.includes(needle))) {
                continue;
            }

            if (entry.isDirectory()) {
                walk(full);
                continue;
            }

            if (entry.isFile() && suffixes.has(extname(entry.name))) {
                out.push(full);
            }
        }
    };

    walk(dir);
    return out;
}
