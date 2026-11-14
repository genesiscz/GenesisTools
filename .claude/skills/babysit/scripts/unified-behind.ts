#!/usr/bin/env bun
/**
 * Does the integration branch hold everything a ref holds? A review fix made on a PR branch must also be on the
 * integration ("unified") branch, whoever pushed it. On 2026-11-10 a master let its fixers push the PR branches
 * themselves, so its own step "cherry-pick the pair onto unified" never ran: 55 `#NNN followup` commits landed on
 * master and were missing from unified for three days, and the next merge of master into unified had 440 conflicts.
 *
 *   bun unified-behind.ts --branch <integration branch> [--repo <checkout>] <ref> [<ref> ...]
 *
 * The test is on the whole branch, not per commit: a merge of the ref into the integration branch, done in memory,
 * must change nothing. A PR branch is recomposed from unified's commits (other commit boundaries, other patch ids)
 * and lands by squash, so a per-commit test (patch id, or the commit's diff applied in reverse) named 133 commits of a
 * landed branch as missing (2026-11-13). It needs a fresh merge base: merge master into the integration branch after
 * every landing.
 *
 * Only a file the merge would change fails the check: a change unified lacks. A place both sides changed is printed
 * and does not fail it (the merge keeps unified's side there), but a clean change elsewhere in the same file does. Unified is ahead of every PR branch on purpose (new commits after the cut),
 * so most such files are unified's later work on the PR's lines (114 files for a branch that had landed whole,
 * 2026-11-13). A fix on lines that unified also changed can therefore pass unseen; the check catches the fix nobody
 * picked in a place unified left alone.
 *
 * Prints the files, the commits of the ref that touch them, and the pick command. Exit 0 when unified lacks no
 * change, 1 when it lacks one, 2 when git cannot answer.
 */
import { flag } from "./run";
import { mustGit } from "./versions";

export interface BehindRef {
    ref: string;
    /** Files a merge of the ref would change in the integration branch: it lacks these changes. */
    lacking: string[];
    /** Files both sides changed in the same place: the merge cannot say which side holds the other. */
    conflicted: string[];
    /** The ref's own commits that touch those files, oldest first (20 at most). */
    commits: { sha: string; subject: string }[];
}

/** One entry per ref whose merge into `branch` would change `branch` or cannot be made; none when it holds them all. */
export function behindUnified(options: { cwd: string; branch: string; refs: string[] }): BehindRef[] {
    const { cwd, branch, refs } = options;
    const must = (args: string[], okCodes = [0]) => {
        const result = mustGit(args, { cwd, okCodes });
        return { code: result.exitCode, out: result.stdout.toString() };
    };
    const behind: BehindRef[] = [];
    const branchTree = must(["rev-parse", `${branch}^{tree}`]).out.trim();

    // Exit 1 is a merge with conflicts: the first line is the tree, the rest are the conflicted files.
    const merge = (ref: string, options: string[]) => {
        const merged = must(
            ["merge-tree", "--write-tree", "--name-only", "--no-messages", ...options, branch, ref],
            [0, 1]
        );
        const [tree, ...names] = merged.out.trim().split("\n");
        return {
            tree,
            clean: merged.code === 0,
            conflicted: merged.code === 1 ? [...new Set(names.filter(Boolean))] : [],
        };
    };

    for (const ref of refs) {
        const plain = merge(ref, []);
        const conflicted = plain.conflicted;
        // `-X ours` settles each conflicting hunk with the integration branch's side and keeps every clean change of
        // the ref, also one in a file that has a conflict elsewhere. What is still in conflict (a file one side
        // deleted, a rename on both sides) has no tree to compare, so it stays out of `lacking`. A clean merge has no
        // hunk to settle, so its tree already is the settled one.
        const settled = plain.clean ? plain : merge(ref, ["-X", "ours"]);
        const lacking = must(["diff", "--name-only", branchTree, settled.tree])
            .out.split("\n")
            .filter((file) => file && !settled.conflicted.includes(file));

        if (lacking.length === 0 && conflicted.length === 0) {
            continue;
        }

        const base = must(["merge-base", branch, ref]).out.trim();
        const commits = must([
            "log",
            "--no-merges",
            "--reverse",
            "--format=%H%x09%s",
            `${base}..${ref}`,
            "--",
            ...lacking,
            ...conflicted,
        ])
            .out.split("\n")
            .filter(Boolean)
            .slice(-20)
            .map((line) => {
                const [sha, subject] = line.split("\t");
                return { sha, subject };
            });
        behind.push({ ref, lacking, conflicted, commits });
    }

    return behind;
}

/** Whether the integration branch lacks a change of one of the refs. A file both changed in one place does not count. */
export function lacksChanges(behind: BehindRef[]): boolean {
    return behind.some((entry) => entry.lacking.length > 0);
}

/** The lines a caller prints for the refs `behindUnified` returned. */
export function behindReport(branch: string, behind: BehindRef[]): string[] {
    const lines: string[] = [];
    const files = (list: string[]) => `${list.slice(0, 8).join(", ")}${list.length > 8 ? `, … (${list.length})` : ""}`;

    for (const entry of behind) {
        lines.push(
            entry.lacking.length > 0
                ? `✖ ${branch} does not hold everything of ${entry.ref}:`
                : `⚠ ${branch} lacks no change of ${entry.ref}, but this check cannot judge every file:`
        );
        if (entry.lacking.length > 0) {
            lines.push(`  it lacks changes in ${entry.lacking.length} file(s): ${files(entry.lacking)}`);
        }

        if (entry.conflicted.length > 0) {
            lines.push(
                `  both changed the same place in ${entry.conflicted.length} file(s): ${files(entry.conflicted)}`
            );
        }

        if (entry.lacking.length === 0) {
            continue;
        }

        for (const commit of entry.commits) {
            lines.push(`  ${commit.sha.slice(0, 10)} ${commit.subject.slice(0, 100)}`);
        }

        if (entry.commits.length > 0) {
            lines.push(
                `Pick the ones ${branch} lacks, in the checkout that has it: bun .claude/skills/babysit/scripts/pick-unified.ts --branch ${branch} ${entry.commits.map((commit) => commit.sha.slice(0, 10)).join(" ")}`
            );
        }
    }

    return lines;
}

function main(): void {
    const branch = flag("--branch");
    const flagValues = new Set([branch, flag("--repo")]);
    const refs = process.argv.slice(2).filter((arg) => !arg.startsWith("--") && !flagValues.has(arg));

    if (!branch || refs.length === 0) {
        console.error("usage: unified-behind.ts --branch <integration branch> [--repo <checkout>] <ref> [<ref> ...]");
        process.exit(2);
    }

    let behind: BehindRef[];
    try {
        behind = behindUnified({ cwd: flag("--repo") ?? process.cwd(), branch, refs });
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(2);
    }

    if (behind.length > 0) {
        console.error(behindReport(branch, behind).join("\n"));
    }

    if (lacksChanges(behind)) {
        process.exit(1);
    }

    console.log(`✔ ${branch} lacks no change of ${refs.join(", ")}`);
}

if (import.meta.main) {
    main();
}
