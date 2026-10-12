#!/usr/bin/env bun
/**
 * Checks commit subjects against the rules in scripts/git/commit-scopes.ts.
 *
 *   bun scripts/git/check-commits.ts <range>               every non-merge commit in the range (origin/master..HEAD)
 *   bun scripts/git/check-commits.ts --message-file <file> the message about to be committed, against the staged
 *                                                          files (what .githooks/commit-msg runs)
 *
 * Each broken rule is printed with the corrected subject; the exit code is 1 when anything is wrong.
 */
import { readFileSync } from "node:fs";
import { checkSubject } from "./commit-scopes";

function git(args: string[]): string {
    const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString().trim()}`);
    }

    return proc.stdout.toString();
}

function report(label: string, subject: string, files: string[]): boolean {
    const result = checkSubject(subject, files);
    if (result.problems.length === 0) {
        return true;
    }

    const lines = [`✗ ${label}${subject}`, `  → ${result.subject}`, ...result.problems.map((p) => `    - ${p}`)];
    process.stderr.write(`${lines.join("\n")}\n`);
    return false;
}

/** Messages git or a tool writes for you, which keep their own form. */
const GENERATED = /^(Merge |Revert "|fixup! |squash! |amend! )/;

function checkMessageFile(path: string): number {
    const first =
        readFileSync(path, "utf8")
            .split("\n")
            .find((line) => line.trim() !== "" && !line.startsWith("#"))
            ?.trim() ?? "";
    if (!first || GENERATED.test(first)) {
        return 0;
    }

    let files = git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
    if (files.length === 0) {
        // `git commit --amend` with nothing staged rewords the last commit: its own files decide the scope.
        files = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).split("\n").filter(Boolean);
    }

    if (report("", first, files)) {
        return 0;
    }

    process.stderr.write("commit-msg: fix the subject above (rules: scripts/git/commit-scopes.ts), or --no-verify.\n");
    return 1;
}

function checkRange(range: string): number {
    const out = git(["log", "--no-merges", "--format=%x00%h%x01%s", "--name-only", range]);
    let bad = 0;
    let total = 0;

    for (const chunk of out.split("\0").slice(1)) {
        const [head, ...rest] = chunk.split("\n");
        const [sha, subject] = head.split("\x01");
        total++;

        if (!GENERATED.test(subject) && !report(`${sha} `, subject, rest.filter(Boolean))) {
            bad++;
        }
    }

    const summary = `check-commits: ${total} commit(s) in ${range}, ${bad} with a subject to fix.\n`;
    (bad > 0 ? process.stderr : process.stdout).write(summary);
    return bad > 0 ? 1 : 0;
}

const args = process.argv.slice(2);
const fileFlag = args.indexOf("--message-file");

if (fileFlag >= 0 && args[fileFlag + 1]) {
    process.exitCode = checkMessageFile(args[fileFlag + 1]);
} else if (args[0] && !args[0].startsWith("-")) {
    process.exitCode = checkRange(args[0]);
} else {
    process.stderr.write("usage: bun scripts/git/check-commits.ts <range> | --message-file <file>\n");
    process.exitCode = 2;
}
