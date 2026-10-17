#!/usr/bin/env bun
/**
 * Every committed JSON file parses. Biome reads only the root's JSON files (`files.includes` lists `*.{json,mjs,cjs}`,
 * which matches no nested folder), so a broken nested file passed every gate: on 2026-10-14 a conflict resolution wrote the word `ours`
 * into both plugin manifests (d9687720a), the pre-commit hook printed "Checked 0 files", and the genesis-tools plugin
 * failed to load in every new session for 12 hours. tsconfig files, `.jsonc` files and `.vscode/` settings are JSON
 * with comments by convention and are read that way; every other file must be strict JSON.
 *
 *   bun scripts/ci/check-json.ts            # every tracked .json and .jsonc file (CI)
 *   bun scripts/ci/check-json.ts --staged   # the staged copies (the pre-commit hook)
 *
 * Exit 0 when all parse, 1 naming each file that does not, 2 when git cannot list or read the files.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

const PATHSPEC = ["--", "*.json", "*.jsonc"];

export function allowsComments(path: string): boolean {
    return /^tsconfig.*\.json$/.test(basename(path)) || path.endsWith(".jsonc") || /(^|\/)\.vscode\//.test(path);
}

/** Why a JSON file does not parse, or null when it does. */
export function jsonProblem(path: string, text: string): string | null {
    try {
        SafeJSON.parse(text, allowsComments(path) ? null : { strict: true });
        return null;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

function git(args: string[]): string {
    const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });

    if (result.exitCode !== 0) {
        console.error(`✖ git ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`);
        process.exit(2);
    }

    return result.stdout.toString();
}

function main(): void {
    const staged = process.argv.includes("--staged");
    const paths = git(
        staged
            ? ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR", ...PATHSPEC]
            : ["ls-files", "-z", ...PATHSPEC]
    )
        .split("\0")
        .filter(Boolean);
    let checked = 0;
    let broken = 0;

    for (const path of paths) {
        // A tracked file deleted in the working tree but not yet staged is not this check's business.
        if (!staged && !existsSync(path)) {
            continue;
        }

        const problem = jsonProblem(path, staged ? git(["show", `:${path}`]) : readFileSync(path, "utf8"));
        checked++;

        if (problem) {
            broken++;
            console.error(`✖ ${path}: ${problem}`);
        }
    }

    if (broken > 0) {
        console.error(`✖ ${broken} of ${checked} JSON file(s) do not parse`);
        process.exit(1);
    }

    console.log(`✔ ${checked} JSON file(s) parse`);
}

if (import.meta.main) {
    main();
}
