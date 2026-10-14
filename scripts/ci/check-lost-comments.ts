#!/usr/bin/env bun
/**
 * A comment block deleted together with the import below it, whose text appears nowhere in the new file. That is
 * the shape Biome's unsafe `noUnusedImports` fix leaves: it removes the import with its leading comment, which is
 * often the file header, and reports only "Fixed N files". On 2026-10-14 a sweep lost a 27-line header in
 * scripts/benchmarks/ai-usage/poll-duty.ts and a 12-line one in perf-report.ts that way; a diff review caught it, no
 * gate did. The shell guard now blocks `biome --unsafe` (rule biome-unsafe-deletes-comments); this check catches
 * the same loss from any other tool: a codemod, an editor's organize-imports, another agent.
 *
 * Reported: a block of three or more comment lines, or any file header (the comment at the top of the file), that
 * ends directly above a removed import (blank lines between are allowed), when at least half of its text lines are
 * missing from the new file and, for a header, the new file starts without a header of its own (a rewritten header
 * is a deliberate change). Two short lines about one import are removed with it all the time and are not reported.
 *
 *   bun scripts/ci/check-lost-comments.ts --staged           # the staged diff (the pre-commit hook)
 *   bun scripts/ci/check-lost-comments.ts --range A..B       # every commit in a range (an audit)
 *
 * A deliberate removal passes with GT_ALLOW_LOST_COMMENTS=1 in the commit's environment.
 * Exit 0 when nothing is lost, 1 naming each loss, 2 when git fails.
 */

const SOURCE_PATHSPEC = ["--", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"];
const MIN_BLOCK_LINES = 3;

export interface LostComment {
    file: string;
    /** Line of the block's first line in the old file. */
    oldLine: number;
    header: boolean;
    /** The comment text lines that are missing from the new file. */
    missing: string[];
    importLine: string;
}

interface Hunk {
    oldStart: number;
    removed: string[];
}

export interface FileDiff {
    file: string;
    hunks: Hunk[];
}

const isComment = (line: string) => /^\s*(\/\/|\/\*|\*|\*\/)/.test(line);
const isImport = (line: string) => /^\s*import\b/.test(line);
const textOf = (line: string) =>
    line
        .replace(/^\s*(\/\/+|\/\*+|\*\/|\*)\s?/, "")
        .replace(/\*\/\s*$/, "")
        .trim();

/** Per-file hunks of a `git diff -U0` output. Deleted files are left out: nothing of theirs survives anyway. */
export function parseZeroContextDiff(diff: string): FileDiff[] {
    const files: FileDiff[] = [];
    let current: FileDiff | null = null;
    let hunk: Hunk | null = null;
    let deleted = false;

    const close = () => {
        if (current && !deleted) {
            files.push(current);
        }

        current = null;
        hunk = null;
        deleted = false;
    };

    for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git ")) {
            close();
            current = { file: line.slice(line.lastIndexOf(" b/") + 3), hunks: [] };
            continue;
        }

        if (!current) {
            continue;
        }

        if (line.startsWith("deleted file mode")) {
            deleted = true;
            continue;
        }

        const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);

        if (header) {
            hunk = { oldStart: Number(header[1]), removed: [] };
            current.hunks.push(hunk);
            continue;
        }

        if (hunk && line.startsWith("-") && !line.startsWith("--- ")) {
            hunk.removed.push(line.slice(1));
        }
    }

    close();
    return files;
}

/** True when everything above `line` (1-based) in the old file is blank, a shebang or a directive. */
function startsTheFile(oldContent: string, line: number): boolean {
    return oldContent
        .split("\n")
        .slice(0, line - 1)
        .every((text) => text.trim() === "" || text.startsWith("#!") || /^\s*["']use \w+["'];?\s*$/.test(text));
}

/** The new file opens with a comment (after a shebang and blank lines). */
function hasHeader(newContent: string): boolean {
    const first = newContent.split("\n").find((text) => text.trim() !== "" && !text.startsWith("#!"));
    return first !== undefined && isComment(first);
}

export function findLostComments(input: { diff: FileDiff; oldContent: string; newContent: string }): LostComment[] {
    const oldLines = input.oldContent.split("\n");
    const at = (line: number) => oldLines[line - 1] ?? "";
    // Old-file line numbers (1-based) the diff removes. A -U0 hunk removes consecutive lines from its start.
    const removed = new Set(
        input.diff.hunks.flatMap((hunk) => hunk.removed.map((_, offset) => hunk.oldStart + offset))
    );
    const found: LostComment[] = [];

    for (const line of [...removed].sort((a, b) => a - b)) {
        if (!isImport(at(line))) {
            continue;
        }

        // Up over blank lines, removed or kept: the blank line between a header and the import can stay behind.
        let end = line - 1;

        while (end >= 1 && at(end).trim() === "") {
            end--;
        }

        let top = end;

        while (top >= 1 && removed.has(top) && isComment(at(top))) {
            top--;
        }

        const block = oldLines.slice(top, end);

        if (block.length === 0) {
            continue;
        }

        const oldLine = top + 1;
        const atTop = startsTheFile(input.oldContent, oldLine);

        // A new header in its place is a rewrite, which is deliberate.
        if (atTop && hasHeader(input.newContent)) {
            continue;
        }

        const header = atTop;

        if (!header && block.length < MIN_BLOCK_LINES) {
            continue;
        }

        const texts = block.map(textOf).filter((text) => text.length > 8);
        const missing = texts.filter((text) => !input.newContent.includes(text));

        if (missing.length === 0 || missing.length * 2 < texts.length) {
            continue;
        }

        found.push({ file: input.diff.file, oldLine, header, missing, importLine: at(line).trim() });
    }

    return found;
}

function git(args: string[], allowMissing = false): string | null {
    const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });

    if (result.exitCode !== 0) {
        if (allowMissing) {
            return null;
        }

        console.error(`✖ git ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`);
        process.exit(2);
    }

    return result.stdout.toString();
}

/** Losses in one diff; `before` and `after` read a path's old and new content. */
function scan(diff: string, before: (file: string) => string, after: (file: string) => string): LostComment[] {
    return parseZeroContextDiff(diff).flatMap((fileDiff) =>
        findLostComments({ diff: fileDiff, oldContent: before(fileDiff.file), newContent: after(fileDiff.file) })
    );
}

function report(losses: Array<LostComment & { commit?: string }>): void {
    for (const loss of losses) {
        const where = `${loss.commit ? `${loss.commit.slice(0, 10)} ` : ""}${loss.file}:${loss.oldLine}`;
        console.error(
            `✖ ${where}: ${loss.header ? "the file header" : "a comment block"} was deleted with \`${loss.importLine}\``
        );

        for (const text of loss.missing.slice(0, 3)) {
            console.error(`    lost: ${text}`);
        }
    }
}

function main(): void {
    const rangeAt = process.argv.indexOf("--range");
    const losses: Array<LostComment & { commit?: string }> = [];

    if (rangeAt > 0) {
        const range = process.argv[rangeAt + 1];
        const commits = (git(["rev-list", "--no-merges", range]) ?? "").split("\n").filter(Boolean);

        for (const commit of commits) {
            const diff = git(["diff", "-U0", "-M", "--no-color", `${commit}^`, commit, ...SOURCE_PATHSPEC], true) ?? "";
            const found = scan(
                diff,
                (file) => git(["show", `${commit}^:${file}`], true) ?? "",
                (file) => git(["show", `${commit}:${file}`], true) ?? ""
            );
            losses.push(...found.map((loss) => ({ ...loss, commit })));
        }
    } else if (process.argv.includes("--staged")) {
        const diff = git(["diff", "--cached", "-U0", "-M", "--no-color", ...SOURCE_PATHSPEC]) ?? "";
        losses.push(
            ...scan(
                diff,
                (file) => git(["show", `HEAD:${file}`], true) ?? "",
                (file) => git(["show", `:${file}`], true) ?? ""
            )
        );
    } else {
        console.error("usage: check-lost-comments.ts --staged | --range A..B");
        process.exit(2);
    }

    if (losses.length === 0) {
        console.log("✔ no comment was deleted with an import");
        return;
    }

    report(losses);

    if (Bun.env.GT_ALLOW_LOST_COMMENTS === "1") {
        console.error(`⚠ ${losses.length} loss(es) allowed by GT_ALLOW_LOST_COMMENTS=1`);
        return;
    }

    console.error(
        `✖ ${losses.length} comment block(s) deleted with an import (Biome's unsafe noUnusedImports fix does this). ` +
            "Put the comment back above the next line, or rerun with GT_ALLOW_LOST_COMMENTS=1 if it is meant to go."
    );
    process.exit(1);
}

if (import.meta.main) {
    main();
}
