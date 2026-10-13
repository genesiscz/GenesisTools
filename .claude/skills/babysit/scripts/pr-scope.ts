#!/usr/bin/env bun
/**
 * The file scope for a worker brief: every file the PR changes, plus the test file of each one that exists, and
 * (with --compare) whether each file differs between a ref (usually the unified branch) and the PR head, which
 * predicts a cherry-pick conflict. Read-only: `gh api` and `git` reads only. Run `git fetch origin <pr branch>`
 * first: a ref git cannot resolve prints "unknown", never "same".
 *
 * The list is the OUTER bound of a brief's scope. Narrow it to the files the findings cite plus their tests; a
 * one-thread fix does not need the PR's 57 files.
 *
 * Usage: bun .claude/skills/babysit/scripts/pr-scope.ts <pr> [--compare HEAD] [--json]
 */
import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

const args = process.argv.slice(2);
const pr = args.find((arg) => /^\d+$/.test(arg));
const compareIndex = args.indexOf("--compare");
const compare = compareIndex >= 0 ? args[compareIndex + 1] : undefined;

if (!pr) {
    console.error("usage: pr-scope.ts <pr> [--compare <ref>] [--json]");
    process.exit(2);
}

function run(cmd: string[]): string {
    const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });

    if (result.exitCode !== 0) {
        throw new Error(`${cmd.join(" ")} failed: ${result.stderr.toString().trim()}`);
    }

    return result.stdout.toString();
}

// `gh pr view --json files` stops at 100 files; the REST endpoint pages.
const files = run(["gh", "api", `repos/{owner}/{repo}/pulls/${pr}/files`, "--paginate", "--jq", ".[].filename"])
    .trim()
    .split("\n")
    .filter(Boolean);
const head = run(["gh", "pr", "view", pr, "--json", "headRefName", "--jq", ".headRefName"]).trim();

/** The existing test file for a source file: `x.test.ts` beside it, or a Swift `<Name>Tests.swift` under Tests/. */
function testFileOf(file: string): string | null {
    const ext = extname(file);

    if (/\.test\.|Tests?\.swift$/.test(file)) {
        return null;
    }

    if (ext === ".ts" || ext === ".tsx") {
        const sibling = join(dirname(file), `${basename(file, ext)}.test${ext}`);

        if (existsSync(sibling)) {
            return sibling;
        }

        // A module without its own test file is often tested through a neighbour that imports it (types.ts → grok.test.ts).
        const importers = Bun.spawnSync(
            ["rg", "-l", "--glob", "*.test.ts", `from "\\./${basename(file, ext)}(\\.ts)?"`, dirname(file)],
            { stdout: "pipe", stderr: "pipe" }
        );

        return importers.stdout.toString().trim().split("\n").filter(Boolean)[0] ?? null;
    }

    if (ext === ".swift") {
        const name = basename(file, ext);
        const found = run(["git", "ls-files", `*Tests/*${name}*Tests.swift`])
            .trim()
            .split("\n")
            .filter(Boolean);

        return found[0] ?? null;
    }

    return null;
}

const rows = files.map((file) => {
    let differs: boolean | "unknown" | null = null;

    if (compare) {
        const result = Bun.spawnSync(["git", "diff", "--quiet", `origin/${head}`, compare, "--", file], {
            stdout: "pipe",
            stderr: "pipe",
        });
        // 0 same, 1 differs, anything else (128: a ref git cannot resolve) proves nothing
        differs = result.exitCode === 0 ? false : result.exitCode === 1 ? true : "unknown";
    }

    return { file, test: testFileOf(file), differs };
});
const tests = [...new Set(rows.map((row) => row.test).filter((test): test is string => test !== null))].filter(
    (test) => !files.includes(test)
);

if (args.includes("--json")) {
    process.stdout.write(`${SafeJSON.stringify({ pr: Number(pr), head, files: rows, extraTests: tests })}\n`);
} else {
    console.log(`PR #${pr} (${head}): ${files.length} file(s), ${tests.length} test file(s) outside the diff`);
    for (const row of rows) {
        const mark =
            row.differs === null
                ? ""
                : row.differs === "unknown"
                  ? `  ? unknown (fetch origin/${head} first)`
                  : row.differs
                    ? `  ⚠ differs on ${compare}`
                    : "  same";
        console.log(`  - \`${row.file}\`${mark}`);
    }

    for (const test of tests) {
        console.log(`  - \`${test}\` (test file, not in the PR)`);
    }
}
