import { basename } from "node:path";

/**
 * What KIND of change this is, so the noisy kinds can be switched off without switching off
 * the watcher.
 *
 * The cases that prompted it, both measured 2026-09-21: a command redirected a jest run into
 * `/tmp/z1.log` and the next run truncated it, which rendered as `Updated /tmp/z1.log
 * (+0 -27)` of stack traces; and a formatter pass renders as a wall of lines that say the
 * same thing they said before.
 *
 * `source` is everything that is not one of the others, and is the only category that is
 * never a guess.
 */
export type DiffCategory = "source" | "log" | "generated" | "formatting";

export const DIFF_CATEGORIES: DiffCategory[] = ["source", "log", "generated", "formatting"];

/** Output a program wrote for a human to read once. */
const LOG_EXTENSIONS = new Set([".log", ".out", ".err", ".trace"]);
const LOG_DIRECTORIES = new Set(["logs", "log"]);

/** Output a program wrote for another program to read. */
const GENERATED_NAMES = new Set([
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "composer.lock",
    "Cargo.lock",
    "poetry.lock",
    "junit.xml",
    "test-results.xml",
]);
const GENERATED_EXTENSIONS = new Set([".snap", ".map", ".tsbuildinfo"]);
const GENERATED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "__snapshots__", ".turbo"]);

function segments(path: string): string[] {
    return path.split("/").filter((part) => part.length > 0);
}

function extensionOf(name: string): string {
    const dot = name.lastIndexOf(".");

    return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

function pathCategory(path: string): DiffCategory | null {
    const name = basename(path);
    const parts = segments(path);
    const extension = extensionOf(name);

    if (GENERATED_NAMES.has(name) || GENERATED_EXTENSIONS.has(extension) || name.includes(".min.")) {
        return "generated";
    }

    if (parts.some((part) => GENERATED_DIRECTORIES.has(part))) {
        return "generated";
    }

    if (LOG_EXTENSIONS.has(extension)) {
        return "log";
    }

    // Only a DIRECTORY named `logs`, never a file that merely has the word in its name:
    // `src/logger/logs.ts` is source.
    return parts.slice(0, -1).some((part) => LOG_DIRECTORIES.has(part)) ? "log" : null;
}

/** Whitespace collapsed, so reindentation and a re-wrap compare equal. */
function normalize(line: string): string {
    return line.trim().replace(/\s+/g, " ");
}

/**
 * Whether the patch moves lines around without changing what any of them SAY.
 *
 * It is the shape a formatter leaves: reindentation, a re-wrap, sorted imports. The test is
 * that the added and removed lines are the same multiset once whitespace is collapsed, which
 * also catches a pure reordering. That is a deliberate over-reach rather than a defect: this
 * category ships VISIBLE, so a wrongly-labelled change is still printed, only tagged.
 */
function isFormattingOnly(patch: string): boolean {
    const added: string[] = [];
    const removed: string[] = [];

    for (const line of patch.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) {
            continue;
        }

        if (line.startsWith("+")) {
            added.push(normalize(line.slice(1)));
        } else if (line.startsWith("-")) {
            removed.push(normalize(line.slice(1)));
        }
    }

    if (added.length === 0 || removed.length === 0) {
        return false;
    }

    if (added.length !== removed.length) {
        return false;
    }

    const left = [...added].sort();
    const right = [...removed].sort();

    return left.every((value, index) => value === right[index]);
}

/**
 * The path decides first, because it is certain: a `.log` full of reformatted lines is still
 * a log. Only then is the patch inspected, which is the one category that has to be inferred.
 */
export function classifyChange(path: string, patch: string): DiffCategory {
    return pathCategory(path) ?? (isFormattingOnly(patch) ? "formatting" : "source");
}
