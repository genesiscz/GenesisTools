import type { Dirent, Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { logger } from "@genesiscz/utils/logger";
import { glob } from "glob";
import { describeReadError } from "./hash-stream";

export type HashInput =
    | { kind: "stdin" }
    | { kind: "file"; path: string }
    | { kind: "error"; path: string; message: string };

function hasGlobMagic(pattern: string): boolean {
    return /[*?[\]{}]/.test(pattern);
}

async function statOrNull(path: string): Promise<Stats | null> {
    try {
        return await stat(path);
    } catch (error) {
        logger.debug({ path, error }, "hash: stat failed");
        return null;
    }
}

function compareNames(a: string, b: string): number {
    if (a === b) {
        return 0;
    }

    return a < b ? -1 : 1;
}

function joinPath(dir: string, name: string): string {
    if (dir.endsWith("/")) {
        return `${dir}${name}`;
    }

    return `${dir}/${name}`;
}

/**
 * Every regular file under `dir` (a symlink counts when it resolves to one), sorted by name, never entering a
 * symlinked directory. A directory it cannot read becomes an error entry in its place; the files around it stay.
 */
async function inputsUnder(dir: string): Promise<HashInput[]> {
    let entries: Dirent[];
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
        logger.debug({ path: dir, error }, "hash: readdir failed");
        return [{ kind: "error", path: dir, message: describeReadError(error) }];
    }

    entries.sort((a, b) => compareNames(a.name, b.name));
    const inputs: HashInput[] = [];

    for (const entry of entries) {
        const path = joinPath(dir, entry.name);
        if (entry.isDirectory()) {
            inputs.push(...(await inputsUnder(path)));
        } else if (entry.isFile()) {
            inputs.push({ kind: "file", path });
        } else if (entry.isSymbolicLink() && (await statOrNull(path))?.isFile()) {
            inputs.push({ kind: "file", path });
        }
    }

    return inputs;
}

async function expandOne(argument: string): Promise<HashInput[]> {
    if (argument === "-") {
        return [{ kind: "stdin" }];
    }

    let info: Stats | null = null;
    let statError: unknown;
    try {
        info = await stat(argument);
    } catch (error) {
        statError = error;
        logger.debug({ path: argument, error }, "hash: stat failed");
    }

    if (info?.isDirectory()) {
        const inputs = await inputsUnder(argument);
        logger.debug({ directory: argument, inputs: inputs.length }, "hash: expanded directory");
        return inputs;
    }

    if (info !== null) {
        return [{ kind: "file", path: argument }];
    }

    if (hasGlobMagic(argument)) {
        const matches = await glob(argument, { nodir: true });
        matches.sort();
        logger.debug({ pattern: argument, matches: matches.length }, "hash: expanded glob");
        if (matches.length > 0) {
            return matches.map((path): HashInput => ({ kind: "file", path }));
        }
    }

    return [{ kind: "error", path: argument, message: describeReadError(statError) }];
}

/**
 * Turns the command line into what to hash, in argument order: `-` is stdin, a directory is every file beneath it,
 * a pattern with glob characters is its matches (unless a file of that exact name exists), and anything else is a
 * file. A path that cannot be found, or a directory that cannot be read, becomes an error entry so the others still
 * run. Repeats are dropped.
 */
export async function expandInputs(argumentsList: string[]): Promise<HashInput[]> {
    const seen = new Set<string>();
    const inputs: HashInput[] = [];

    for (const argument of argumentsList) {
        for (const input of await expandOne(argument)) {
            const key = input.kind === "stdin" ? "-" : `${input.kind}:${input.path}`;
            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            inputs.push(input);
        }
    }

    return inputs;
}
