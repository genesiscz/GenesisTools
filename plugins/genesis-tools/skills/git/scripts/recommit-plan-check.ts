#!/usr/bin/env bun
/**
 * Check a recommit plan BEFORE the first commit exists.
 *
 *     recommit-plan-check.ts --base <sha> [--head <ref>] [-C <dir>] --list
 *     recommit-plan-check.ts --base <sha> [--head <ref>] [-C <dir>] --plan <file>
 *
 * `--list` prints the canonical path list: every path whose blob differs between base and
 * head, with rename detection OFF. With detection on (git's default) a moved file shows only
 * its new path, the old path never reaches the categoriser, and no group stages the deletion.
 * Observed 2026-09-04: 210 paths with detection on, 216 without; the six missing ones were
 * files the branch had deleted, and they came back to life in the recomposed branch.
 *
 * `--plan` reads the Phase 5 output (`COMMIT n: <message>` lines, each followed by `FILES:`
 * and one path per line, bullets and indentation allowed) and checks, without touching the
 * working tree or the index. Between `COMMIT` and `FILES:` a group may carry
 * `AUTHOR: Name <email> [date]` and a `BODY:` line followed by `| `-prefixed body lines;
 * recommit.ts writes and uses them, this check ignores them.
 *   1. no path is claimed by two groups;
 *   2. the union of the groups equals the canonical list (nothing missing, nothing extra);
 *   3. replaying the groups in order onto the base tree in a temporary index changes the
 *      tree at every step and ends at head's tree, byte for byte.
 * Check 3 is the Phase 7d tree-identity gate run BEFORE any commit exists, so a bad plan is
 * fixed by editing the plan, not by resetting to the backup tag and redoing every commit.
 * The list the plan is checked against comes from a different command than the one that
 * produced the plan's input, so the check cannot confirm itself.
 *
 * Used by the gt:git skill, references/recommit.md Phases 3, 5 and 7.
 *
 * Exit codes: 0 plan is complete · 1 plan is wrong (details on stderr) · 2 usage or git error.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const USAGE = "usage: recommit-plan-check.ts --base <sha> [--head <ref>] [-C <dir>] (--list | --plan <file>)\n";

interface GitResult {
    code: number;
    stdout: string;
    stderr: string;
}

interface GitOptions {
    cwd: string;
    input?: string;
    indexFile?: string;
    env?: Record<string, string>;
}

/**
 * Runs git with no output limit. spawnSync stops reading at `maxBuffer` (1 MiB by default) and
 * then reports ENOBUFS in `error`, with `status` 0 when git had already exited: a cut listing
 * that looks complete. Any spawn error, signal or missing status therefore throws.
 */
export function runGit(args: string[], { cwd, input, indexFile, env }: GitOptions): GitResult {
    const r = spawnSync("git", ["-C", cwd, ...args], {
        input,
        env: { ...process.env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}), ...env },
        encoding: "utf8",
        maxBuffer: Number.POSITIVE_INFINITY,
    });

    if (r.error || r.status === null) {
        throw new Error(
            `git ${args.slice(0, 3).join(" ")} did not finish (${r.error?.message ?? `signal ${r.signal}`}); its output may be incomplete`
        );
    }

    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function must(result: GitResult, what: string): string {
    if (result.code !== 0) {
        throw new Error(`${what} failed (${result.code}): ${result.stderr.trim()}`);
    }

    return result.stdout;
}

export interface PlanAuthor {
    name: string;
    email: string;
    /** Any date `GIT_AUTHOR_DATE` accepts; without it git uses the time of the commit. */
    date?: string;
}

export interface PlanGroup {
    index: number;
    message: string;
    body?: string;
    author?: PlanAuthor;
    paths: string[];
}

export function formatAuthor(author: PlanAuthor): string {
    return `${author.name} <${author.email}>${author.date ? ` ${author.date}` : ""}`;
}

function parseAuthor(text: string, index: number): PlanAuthor {
    const match = /^([^<>]*?)\s*<([^<>]+)>\s*(.*)$/.exec(text.trim());

    if (!match?.[1]) {
        throw new Error(`COMMIT ${index}: AUTHOR must be "Name <email> [date]", got "${text.trim()}"`);
    }

    return match[3] ? { name: match[1], email: match[2], date: match[3] } : { name: match[1], email: match[2] };
}

/**
 * Old plans (no AUTHOR, no BODY, even no FILES:) parse as before: AUTHOR and BODY are read only
 * between a COMMIT line and its FILES: line, and every line after FILES: is a path.
 */
export function parsePlan(text: string): PlanGroup[] {
    const groups: PlanGroup[] = [];
    let section: "head" | "body" | "files" = "head";

    for (const raw of text.split("\n")) {
        const line = raw.trim();
        const header = /^COMMIT\s+(\d+)\s*:\s*(.*)$/.exec(line);

        if (header) {
            groups.push({ index: Number(header[1]), message: header[2] ?? "", paths: [] });
            section = "head";
            continue;
        }

        const last = groups.at(-1);

        if (last && section === "body" && line.startsWith("|")) {
            const bodyLine = raw
                .slice(raw.indexOf("|") + 1)
                .replace(/^ /, "")
                .replace(/\r$/, "");
            last.body = last.body === undefined ? bodyLine : `${last.body}\n${bodyLine}`;
            continue;
        }

        if (line === "") {
            continue;
        }

        if (/^FILES\s*:/.test(line)) {
            section = "files";
            continue;
        }

        if (!last) {
            throw new Error(`path before the first COMMIT line: ${line}`);
        }

        if (section !== "files" && /^BODY\s*:$/.test(line)) {
            section = "body";
            continue;
        }

        const author = section === "files" ? null : /^AUTHOR\s*:(.*)$/.exec(line);

        if (author) {
            last.author = parseAuthor(author[1] ?? "", last.index);
            section = "head";
            continue;
        }

        if (section === "body") {
            section = "head";
        }

        last.paths.push(line.replace(/^[-*]\s+/, "").replace(/^`(.*)`$/, "$1"));
    }

    return groups;
}

/** The plan text `parsePlan` reads back: groups numbered from 1, paths as given. */
export function formatPlan(groups: Omit<PlanGroup, "index">[]): string {
    const blocks = groups.map((group, gi) =>
        [
            `COMMIT ${gi + 1}: ${group.message}`,
            ...(group.author ? [`AUTHOR: ${formatAuthor(group.author)}`] : []),
            ...(group.body === undefined
                ? []
                : ["BODY:", ...group.body.split("\n").map((line) => (line === "" ? "|" : `| ${line}`))]),
            "FILES:",
            ...group.paths,
        ].join("\n")
    );

    return `${blocks.join("\n\n")}\n`;
}

export interface RangeChanges {
    /** Every path base..head changes, sorted: the canonical list. */
    paths: string[];
    /** The paths base..head deletes. */
    deleted: Set<string>;
}

/** What base..head changes, from one `diff-tree` with rename detection off, so both lists come from the same diff. */
export function rangeChanges({ cwd, base, head }: { cwd: string; base: string; head: string }): RangeChanges {
    const fields = must(
        runGit(["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", "--name-status", base, head], { cwd }),
        "git diff-tree"
    ).split("\0");
    const paths: string[] = [];
    const deleted = new Set<string>();

    // `-z --name-status` writes a status field, then its path, each ended by NUL.
    for (let i = 0; i + 1 < fields.length; i += 2) {
        const path = fields[i + 1];
        paths.push(path);

        if (fields[i] === "D") {
            deleted.add(path);
        }
    }

    return { paths: paths.sort(), deleted };
}

export function canonicalPaths({ cwd, base, head }: { cwd: string; base: string; head: string }): string[] {
    return rangeChanges({ cwd, base, head }).paths;
}

/** The id of the tree of `ref`. */
export function treeOf({ cwd, ref }: { cwd: string; ref: string }): string {
    return must(runGit(["rev-parse", "--verify", `${ref}^{tree}`], { cwd }), "git rev-parse").trim();
}

export interface TreeEntry {
    mode: string;
    sha: string;
}

export type EntryReader = (args: { cwd: string; ref: string; paths: string[] }) => Map<string, TreeEntry>;

/** Path bytes per `ls-tree` call, far below the argument limit (1 MiB with the environment on macOS). */
const PATH_ARG_BYTES = 60_000;

function chunkByBytes(items: string[], limit: number): string[][] {
    const chunks: string[][] = [];
    let current: string[] = [];
    let size = 0;

    for (const item of items) {
        const bytes = Buffer.byteLength(item) + 1;

        if (current.length > 0 && size + bytes > limit) {
            chunks.push(current);
            current = [];
            size = 0;
        }

        current.push(item);
        size += bytes;
    }

    if (current.length > 0) {
        chunks.push(current);
    }

    return chunks;
}

/**
 * The entries of `paths` in `ref` (blob, symlink or submodule), read path by path rather than as
 * the whole listing, which in a large repo is megabytes. A path that is absent or a directory in
 * `ref` has no entry. Literal pathspecs, so `:x`, `*` and `[` in a name match only themselves.
 */
export const treeEntries: EntryReader = ({ cwd, ref, paths }) => {
    const wanted = new Set(paths);
    const entries = new Map<string, TreeEntry>();

    for (const chunk of chunkByBytes([...wanted], PATH_ARG_BYTES)) {
        const out = must(
            runGit(["--literal-pathspecs", "ls-tree", "-r", "-z", "--full-tree", ref, "--", ...chunk], { cwd }),
            "git ls-tree"
        );

        for (const record of out.split("\0").filter(Boolean)) {
            const tab = record.indexOf("\t");
            const path = record.slice(tab + 1);

            if (wanted.has(path)) {
                const [mode, , sha] = record.slice(0, tab).split(" ");
                entries.set(path, { mode: mode ?? "", sha: sha ?? "" });
            }
        }
    }

    return entries;
};

export interface HeadIndex {
    /** The `update-index --index-info` line that sets each resolved path to its state in head. */
    lines: Map<string, string>;
    /** Paths with no entry in head that base..head does not delete either. */
    unresolved: string[];
}

/**
 * Head's entry for each path, or a deletion line for a path base..head deletes. A path with no
 * entry that is not deleted is unresolved and gets no line: an entry lookup that came back short
 * must never turn into a deleted file. A caller that already has `deleted` (`rangeChanges`) or
 * head's tree passes them, so neither is read twice.
 */
export function headIndexLines({
    cwd,
    base,
    head,
    paths,
    readEntries = treeEntries,
    deleted = rangeChanges({ cwd, base, head }).deleted,
    headTree = treeOf({ cwd, ref: head }),
}: {
    cwd: string;
    base: string;
    head: string;
    paths: string[];
    readEntries?: EntryReader;
    deleted?: Set<string>;
    headTree?: string;
}): HeadIndex {
    const entries = readEntries({ cwd, ref: head, paths });
    // The null id has the length of the repository's hash (SHA-1 or SHA-256).
    const zero = "0".repeat(headTree.length);
    const lines = new Map<string, string>();
    const unresolved: string[] = [];

    for (const path of paths) {
        const entry = entries.get(path);

        if (entry) {
            lines.set(path, `${entry.mode} ${entry.sha}\t${path}`);
        } else if (deleted.has(path)) {
            lines.set(path, `0 ${zero}\t${path}`);
        } else {
            unresolved.push(path);
        }
    }

    return { lines, unresolved };
}

/** "a.ts (git cat-file -e finds it in head), b.ts (…)": which unresolved paths head really has. */
export function describeUnresolved({ cwd, head, paths }: { cwd: string; head: string; paths: string[] }): string {
    return paths
        .map((path) => {
            const inHead = runGit(["cat-file", "-e", `${head}:${path}`], { cwd }).code === 0;
            return `${path} (${inHead ? "git cat-file -e finds it in head" : "not in head, and base..head does not delete it"})`;
        })
        .join(", ");
}

export interface PlanReport {
    problems: string[];
    groups: number;
    paths: number;
}

export function checkPlan({
    cwd,
    base,
    head,
    groups,
}: {
    cwd: string;
    base: string;
    head: string;
    groups: PlanGroup[];
}): PlanReport {
    const problems: string[] = [];

    if (groups.length === 0) {
        return { problems: ["plan has no COMMIT lines"], groups: 0, paths: 0 };
    }

    const owners = new Map<string, number[]>();

    for (const group of groups) {
        for (const path of group.paths) {
            owners.set(path, [...(owners.get(path) ?? []), group.index]);
        }
    }

    for (const [path, indexes] of owners) {
        if (indexes.length > 1) {
            problems.push(`duplicate: ${path} (groups ${indexes.join(", ")})`);
        }
    }

    const changes = rangeChanges({ cwd, base, head });
    const canonical = changes.paths;
    const canonicalSet = new Set(canonical);
    const union = new Set(owners.keys());

    for (const path of canonical) {
        if (!union.has(path)) {
            problems.push(`missing: ${path}`);
        }
    }

    for (const path of [...union].sort()) {
        if (!canonicalSet.has(path)) {
            problems.push(`extra: ${path} (unchanged between base and head)`);
        }
    }

    const headTree = treeOf({ cwd, ref: head });
    const index = headIndexLines({ cwd, base, head, paths: [...union], deleted: changes.deleted, headTree });
    const gaps = index.unresolved.filter((path) => canonicalSet.has(path));

    if (gaps.length > 0) {
        problems.push(
            `lookup: no entry in head for ${describeUnresolved({ cwd, head, paths: gaps })}; a missing entry is never written as a deletion`
        );
    }

    const scratch = mkdtempSync(join(tmpdir(), "recommit-plan-"));
    const indexFile = join(scratch, "index");

    try {
        must(runGit(["read-tree", base], { cwd, indexFile }), "git read-tree");
        let previous = must(runGit(["write-tree"], { cwd, indexFile }), "git write-tree").trim();

        for (const group of groups) {
            const info = group.paths.flatMap((path) => index.lines.get(path) ?? []);

            if (info.length > 0) {
                must(
                    runGit(["update-index", "--index-info"], { cwd, indexFile, input: `${info.join("\n")}\n` }),
                    "git update-index"
                );
            }

            const tree = must(runGit(["write-tree"], { cwd, indexFile }), "git write-tree").trim();

            if (tree === previous) {
                problems.push(`group ${group.index} changes nothing: ${group.message}`);
            }

            previous = tree;
        }

        if (previous !== headTree) {
            problems.push(`tree: replaying the plan gives ${previous}, head tree is ${headTree}`);
        }
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }

    return { problems, groups: groups.length, paths: union.size };
}

function main(argv: string[]): number {
    let base: string | undefined;
    let head = "HEAD";
    let cwd = process.cwd();
    let list = false;
    let planFile: string | undefined;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === "--base") {
            base = argv[++i];
        } else if (arg === "--head") {
            head = argv[++i] ?? head;
        } else if (arg === "-C") {
            cwd = argv[++i] ?? cwd;
        } else if (arg === "--list") {
            list = true;
        } else if (arg === "--plan") {
            planFile = argv[++i];
        } else {
            process.stderr.write(`unknown argument: ${arg}\n${USAGE}`);
            return 2;
        }
    }

    if (!base || list === Boolean(planFile)) {
        process.stderr.write(USAGE);
        return 2;
    }

    try {
        if (list) {
            const paths = canonicalPaths({ cwd, base, head });
            process.stdout.write(paths.map((p) => `${p}\n`).join(""));
            return 0;
        }

        const groups = parsePlan(readFileSync(planFile as string, "utf8"));
        const report = checkPlan({ cwd, base, head, groups });

        if (report.problems.length > 0) {
            process.stderr.write(
                `${report.problems.map((p) => `${p}\n`).join("")}plan is not complete, fix it before Phase 7\n`
            );
            return 1;
        }

        process.stdout.write(`plan: ${report.groups} groups, ${report.paths} paths, tree identity OK\n`);
        return 0;
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
    }
}

if (import.meta.main) {
    process.exitCode = main(process.argv.slice(2));
}
