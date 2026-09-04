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
 * working tree or the index:
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
}

function git(args: string[], { cwd, input, indexFile }: GitOptions): GitResult {
    const env = indexFile ? { ...process.env, GIT_INDEX_FILE: indexFile } : process.env;
    const r = spawnSync("git", ["-C", cwd, ...args], { input, env, encoding: "utf8" });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function must(result: GitResult, what: string): string {
    if (result.code !== 0) {
        throw new Error(`${what} failed (${result.code}): ${result.stderr.trim()}`);
    }

    return result.stdout;
}

interface Group {
    index: number;
    message: string;
    paths: string[];
}

export function parsePlan(text: string): Group[] {
    const groups: Group[] = [];

    for (const raw of text.split("\n")) {
        const line = raw.trim();
        const header = /^COMMIT\s+(\d+)\s*:\s*(.*)$/.exec(line);

        if (header) {
            groups.push({ index: Number(header[1]), message: header[2] ?? "", paths: [] });
            continue;
        }

        if (line === "" || /^FILES\s*:/.test(line)) {
            continue;
        }

        const last = groups.at(-1);

        if (!last) {
            throw new Error(`path before the first COMMIT line: ${line}`);
        }

        last.paths.push(line.replace(/^[-*]\s+/, "").replace(/^`(.*)`$/, "$1"));
    }

    return groups;
}

export function canonicalPaths({ cwd, base, head }: { cwd: string; base: string; head: string }): string[] {
    const out = must(
        git(["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", "--name-only", base, head], { cwd }),
        "git diff-tree"
    );
    return out.split("\0").filter(Boolean).sort();
}

interface HeadEntry {
    mode: string;
    sha: string;
}

function headEntries(cwd: string, head: string): Map<string, HeadEntry> {
    const out = must(git(["ls-tree", "-r", "-z", head], { cwd }), "git ls-tree");
    const entries = new Map<string, HeadEntry>();

    for (const record of out.split("\0").filter(Boolean)) {
        const tab = record.indexOf("\t");
        const [mode, , sha] = record.slice(0, tab).split(" ");
        entries.set(record.slice(tab + 1), { mode: mode ?? "", sha: sha ?? "" });
    }

    return entries;
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
    groups: Group[];
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

    const canonical = canonicalPaths({ cwd, base, head });
    const union = new Set(owners.keys());

    for (const path of canonical) {
        if (!union.has(path)) {
            problems.push(`missing: ${path}`);
        }
    }

    for (const path of [...union].sort()) {
        if (!canonical.includes(path)) {
            problems.push(`extra: ${path} (unchanged between base and head)`);
        }
    }

    const entries = headEntries(cwd, head);
    const shaLength = entries.values().next().value?.sha.length ?? 40;
    const zero = "0".repeat(shaLength);
    const scratch = mkdtempSync(join(tmpdir(), "recommit-plan-"));
    const indexFile = join(scratch, "index");

    try {
        must(git(["read-tree", base], { cwd, indexFile }), "git read-tree");
        let previous = must(git(["write-tree"], { cwd, indexFile }), "git write-tree").trim();

        for (const group of groups) {
            const info = group.paths
                .map((path) => {
                    const entry = entries.get(path);
                    return entry ? `${entry.mode} ${entry.sha}\t${path}\n` : `0 ${zero}\t${path}\n`;
                })
                .join("");
            must(git(["update-index", "--index-info"], { cwd, indexFile, input: info }), "git update-index");
            const tree = must(git(["write-tree"], { cwd, indexFile }), "git write-tree").trim();

            if (tree === previous) {
                problems.push(`group ${group.index} changes nothing: ${group.message}`);
            }

            previous = tree;
        }

        const headTree = must(git(["rev-parse", `${head}^{tree}`], { cwd }), "git rev-parse").trim();

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
