import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { logger } from "@genesiscz/utils/logger";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", ".next", ".git"]);
const TEST_FILE = /[._](test|spec)\.[cm]?tsx?$/;
const GLOB_CHARS = /[*?[{]/;

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

    // A quoted pattern reaches us unexpanded: agents pass `'src/utils/repos*.ts'`, which logged "No TypeScript source
    // found" twice on 2026-10-21. A path that exists as typed is never read as a pattern.
    if (!existsSync(absolute) && GLOB_CHARS.test(input)) {
        const [cwd, pattern] = isAbsolute(input)
            ? [parse(input).root, input.slice(parse(input).root.length)]
            : [process.cwd(), input];
        // Ignores match below the pattern's literal folders, the way they match below a named directory, inside the cwd
        // and outside it. Each match is walked from that base, never re-checked as a root: a root check would test
        // the literal folders above the matches again and drop every match inside the cwd.
        const segments = pattern.split("/");
        const base = join(
            cwd,
            ...segments.slice(
                0,
                segments.findIndex((segment) => GLOB_CHARS.test(segment))
            )
        );
        const ignore = options.ignore ?? [];
        const matches = [...new Bun.Glob(pattern).scanSync({ cwd, absolute: true, onlyFiles: false })].filter(
            (match) => !ignore.some((needle) => relative(base, match).includes(needle))
        );
        const found = matches.flatMap((match) => walk(match, { base, includeTests: options.tests === true, ignore }));
        return [...new Set(found)].filter((file) => isSource(file, options.tests === true)).sort();
    }

    const ignore = options.ignore ?? [];
    // 🛑 A needle matches the path BELOW what the user named, never the directories above it.
    // Tested against the absolute path, `--ignore test` under `/Users/me/test-projects/app`
    // skipped every file and reported "No TypeScript source found". The named path itself is
    // matched as the cwd shows it, so `--ignore .gen.` still skips `src/x.gen.ts` named directly.
    const shownRoot = relative(process.cwd(), absolute);
    const rootOutsideCwd = shownRoot.startsWith("..") || isAbsolute(shownRoot);

    if (!existsSync(absolute) || (!rootOutsideCwd && ignore.some((needle) => shownRoot.includes(needle)))) {
        return [];
    }

    return walk(absolute, { base: absolute, includeTests: options.tests === true, ignore });
}

function walk(path: string, scan: { base: string; includeTests: boolean; ignore: string[] }): string[] {
    try {
        if (!statSync(path).isDirectory()) {
            return [path];
        }
    } catch (err) {
        logger.debug({ path, err }, "collect: could not stat a path, skipping it");

        return [];
    }

    const found: string[] = [];
    let entries: Dirent[];

    try {
        entries = readdirSync(path, { withFileTypes: true });
    } catch (err) {
        logger.debug({ path, err }, "collect: could not read a directory, skipping it");

        return [];
    }

    for (const entry of entries) {
        const child = join(path, entry.name);
        const below = relative(scan.base, child);

        if (scan.ignore.some((needle) => below.includes(needle))) {
            continue;
        }

        if (entry.isDirectory()) {
            if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
                found.push(...walk(child, scan));
            }
        } else if (isSource(entry.name, scan.includeTests)) {
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
