import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { logger } from "@genesiscz/utils/logger";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", ".next", ".git"]);
const TEST_FILE = /[._](test|spec)\.[cm]?tsx?$/;

export interface CollectOptions {
    /** Include `*.test.ts` and `*.spec.ts`, which are skipped by default. */
    tests?: boolean;
    /** Substrings; a path containing any of them is skipped. `--ignore vendor --ignore .gen.` */
    ignore?: string[];
}

export function isTestFile(path: string): boolean {
    return TEST_FILE.test(path);
}

function isSource(path: string, includeTests: boolean): boolean {
    if (path.endsWith(".d.ts") || !SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext))) {
        return false;
    }

    return includeTests || !TEST_FILE.test(path);
}

/**
 * A directory argument expands to every source file under it, so `skeleton src/ts` works.
 *
 * ⚠️ `existsSync` does not make the later `statSync` and `readdirSync` atomic. A path can
 * vanish or become unreadable between the two — a build writing into the tree, a worktree
 * being removed — and an escaping exception aborted the whole command before it printed
 * anything for the files it had already walked. An unreadable entry is skipped and logged
 * instead, because a partial skeleton is worth more than a stack trace.
 */
export function collectFiles(input: string, options: CollectOptions = {}): string[] {
    const absolute = resolve(input);
    const includeTests = options.tests === true;
    const ignore = options.ignore ?? [];
    const ignored = (path: string): boolean => ignore.some((needle) => path.includes(needle));

    if (!existsSync(absolute) || ignored(absolute)) {
        return [];
    }

    try {
        if (!statSync(absolute).isDirectory()) {
            return [absolute];
        }
    } catch (err) {
        logger.debug({ path: absolute, err }, "collect: could not stat a path, skipping it");

        return [];
    }

    const found: string[] = [];
    let entries: Dirent[];

    try {
        entries = readdirSync(absolute, { withFileTypes: true });
    } catch (err) {
        logger.debug({ path: absolute, err }, "collect: could not read a directory, skipping it");

        return [];
    }

    for (const entry of entries) {
        const child = join(absolute, entry.name);

        if (ignored(child)) {
            continue;
        }

        if (entry.isDirectory()) {
            if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
                found.push(...collectFiles(child, options));
            }
        } else if (isSource(entry.name, includeTests)) {
            found.push(child);
        }
    }

    return found.sort();
}

/** Every source file under every input, de-duplicated, with the inputs that matched nothing. */
export function collectAll(inputs: string[], options: CollectOptions = {}): { files: string[]; empty: string[] } {
    const files = new Set<string>();
    const empty: string[] = [];

    for (const input of inputs) {
        const found = collectFiles(input, options);

        if (found.length === 0) {
            empty.push(input);
            continue;
        }

        for (const file of found) {
            files.add(file);
        }
    }

    return { files: [...files].sort(), empty };
}
