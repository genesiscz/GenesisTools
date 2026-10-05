#!/usr/bin/env bun
/**
 * Recompose a branch into a few semantic commits with the final tree byte-identical, without
 * touching the working tree or the index. The judgement (which commits and paths form which
 * group, and each message) stays with the agent; this script does the mechanics and the proofs.
 *
 *     recommit.ts log   --base <ref> [--head <ref>] [-C <dir>]
 *     recommit.ts group --base <ref> [--head <ref>] --groups <groups.json> [--out <plan.txt>] [-C <dir>]
 *     recommit.ts check --base <ref> [--head <ref>] --plan <plan.txt> [-C <dir>]
 *     recommit.ts apply --base <ref> [--head <ref>] --plan <plan.txt> [--branch <name>] [--dry-run]
 *                       [--verify-each "<cmd>"] [-C <dir>]
 *
 * `--base` may be the parent branch tip; the script works from the MERGE-BASE of base and head,
 * so a parent that moved since never leaks its commits into the plan.
 *
 * log    The categoriser's input: every commit oldest first with the paths it touched (rename
 *        detection off, so both halves of a move show), and the canonical path count.
 * group  Turns an agent-written groups file into a plan. groups.json is an array, in commit order:
 *          { "message": "fix(x): …", "commits": ["abc1234", …], "paths": ["src/x/**", "a.ts"], "rest": true }
 *        all fields but `message` optional. Each canonical path goes to: the group whose `paths`
 *        (exact or glob) claim it, else the group whose `commits` touch it most often (a tie goes
 *        to the LATER group and is reported as shared), else the one `rest` group. Fails on a
 *        path two groups claim by `paths`, a path no rule places, a commit listed twice or never
 *        (when any group lists commits), and an empty group. Writes the plan in the
 *        recommit-plan-check format and runs that check.
 * check  The same check as recommit-plan-check.ts --plan: no duplicates, nothing missing or
 *        extra, every step changes the tree, the last step is head's tree byte for byte.
 * apply  Checks the plan, then builds the commits in a temporary index on top of the merge-base
 *        (`commit-tree`, so the working tree, the index and any stash are never touched), proves
 *        the new tip's tree equals head's, tags the old head (`bkp/recommit/<branch>-<stamp>`),
 *        and moves the branch with a compare-and-swap `update-ref`. A worktree that has the branch
 *        checked out stays clean, since the tree is identical. `--dry-run` builds and proves the
 *        commits but moves nothing.
 *
 * What apply proves before it moves anything:
 *   - the final tree equals head's, byte for byte (blobs, modes, symlinks, submodule pointers,
 *     deletions), so no content can be lost;
 *   - per path: every changed path equals the base in every commit before its group, has its exact
 *     final blob and mode (or is absent) from its group's commit on, and is never touched again;
 *     every commit changes only its own group's paths;
 *   - with `--verify-each "<cmd>"`, the command passes on every new commit, each checked out in a
 *     temporary worktree (the checkout's node_modules is linked in). Grouping by commits keeps the
 *     content safe but not each commit buildable: a commit that edits cmux AND a shared util puts
 *     the util in whichever group wins, so a group can depend on a later one. Any failure refuses
 *     the move.
 * `group` prints each group's areas (first two path segments with counts) so a path that landed in
 * the wrong scope is visible; pin it with a `paths` glob.
 *
 * Exit codes: 0 ok · 1 the groups or the plan are wrong (details on stderr) · 2 usage or git error.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPaths, checkPlan, parsePlan } from "./recommit-plan-check";

const USAGE = `usage:
  recommit.ts log   --base <ref> [--head <ref>] [-C <dir>]
  recommit.ts group --base <ref> [--head <ref>] --groups <groups.json> [--out <plan.txt>] [-C <dir>]
  recommit.ts check --base <ref> [--head <ref>] --plan <plan.txt> [-C <dir>]
  recommit.ts apply --base <ref> [--head <ref>] --plan <plan.txt> [--branch <name>] [--dry-run] [--verify-each "<cmd>"] [-C <dir>]
`;

class UsageError extends Error {}

function git(cwd: string, args: string[], opts: { input?: string; indexFile?: string } = {}): string {
    const env = opts.indexFile ? { ...process.env, GIT_INDEX_FILE: opts.indexFile } : process.env;
    const r = spawnSync("git", ["-C", cwd, ...args], { input: opts.input, env, encoding: "utf8" });

    if (r.status !== 0) {
        throw new Error(`git ${args.slice(0, 3).join(" ")} failed (${r.status}): ${(r.stderr ?? "").trim()}`);
    }

    return r.stdout ?? "";
}

function tryGit(cwd: string, args: string[]): string | null {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    return r.status === 0 ? (r.stdout ?? "").trim() : null;
}

interface Args {
    command: string;
    base: string;
    head: string;
    cwd: string;
    groups?: string;
    plan?: string;
    out?: string;
    branch?: string;
    verifyEach?: string;
    dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
    const [command, ...rest] = argv;
    const args: Partial<Args> & { dryRun: boolean } = { command, head: "HEAD", cwd: process.cwd(), dryRun: false };
    const valueFlags: Record<string, keyof Args> = {
        "--base": "base",
        "--head": "head",
        "-C": "cwd",
        "--groups": "groups",
        "--plan": "plan",
        "--out": "out",
        "--branch": "branch",
        "--verify-each": "verifyEach",
    };

    for (let i = 0; i < rest.length; i++) {
        const flag = rest[i];

        if (flag === "--dry-run") {
            args.dryRun = true;
            continue;
        }

        const key = valueFlags[flag];
        const value = rest[i + 1];

        if (!key || value === undefined) {
            throw new UsageError(`unknown or incomplete argument: ${flag}`);
        }

        Object.assign(args, { [key]: value });
        i++;
    }

    if (!["log", "group", "check", "apply"].includes(command ?? "") || !args.base) {
        throw new UsageError("a command and --base are required");
    }

    return args as Args;
}

interface Commit {
    sha: string;
    subject: string;
    paths: string[];
}

function commitsBetween(cwd: string, base: string, head: string): Commit[] {
    return git(cwd, ["rev-list", "--reverse", `${base}..${head}`])
        .split("\n")
        .filter(Boolean)
        .map((sha) => ({
            sha,
            subject: git(cwd, ["log", "-1", "--format=%s", sha]).trim(),
            paths: git(cwd, ["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", "--name-only", "--root", sha])
                .split("\0")
                .filter(Boolean),
        }));
}

interface GroupSpec {
    message: string;
    commits?: string[];
    paths?: string[];
    rest?: boolean;
}

function readGroups(file: string): GroupSpec[] {
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));

    if (!Array.isArray(data) || data.length === 0) {
        throw new UsageError(`${file}: expected a non-empty JSON array of groups`);
    }

    return data.map((raw, i) => {
        const g = raw as GroupSpec;

        if (typeof g?.message !== "string" || g.message.trim() === "" || g.message.includes("\n")) {
            throw new UsageError(`${file}: groups[${i}].message must be one non-empty line`);
        }

        for (const key of Object.keys(g)) {
            if (!["message", "commits", "paths", "rest"].includes(key)) {
                throw new UsageError(
                    `${file}: groups[${i}].${key} is not a known field (message, commits, paths, rest)`
                );
            }
        }

        return g;
    });
}

export interface GroupingResult {
    plan: string;
    problems: string[];
    shared: string[];
    counts: number[];
}

/** Places every canonical path in one group, by the rules in the header. Pure apart from git reads. */
export function groupPaths({
    cwd,
    base,
    head,
    groups,
}: {
    cwd: string;
    base: string;
    head: string;
    groups: GroupSpec[];
}): GroupingResult {
    const problems: string[] = [];
    const shared: string[] = [];
    const commits = commitsBetween(cwd, base, head);
    const listedBy = new Map<string, number[]>();
    const groupCommits: Commit[][] = groups.map((group, gi) =>
        (group.commits ?? []).flatMap((ref) => {
            const sha = tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
            const commit = commits.find((c) => c.sha === sha);

            if (!commit) {
                problems.push(`group ${gi + 1}: commit ${ref} is not in ${base.slice(0, 9)}..${head}`);
                return [];
            }

            listedBy.set(commit.sha, [...(listedBy.get(commit.sha) ?? []), gi]);
            return [commit];
        })
    );

    for (const [sha, owners] of listedBy) {
        if (owners.length > 1) {
            problems.push(`commit ${sha.slice(0, 9)} is listed by groups ${owners.map((g) => g + 1).join(", ")}`);
        }
    }

    if (groups.some((g) => g.commits?.length)) {
        for (const commit of commits.filter((c) => !listedBy.has(c.sha))) {
            problems.push(`commit ${commit.sha.slice(0, 9)} (${commit.subject}) is in no group`);
        }
    }

    const rest = groups.flatMap((g, gi) => (g.rest ? [gi] : []));

    if (rest.length > 1) {
        problems.push(`more than one rest group: ${rest.map((g) => g + 1).join(", ")}`);
    }

    const globs = groups.map((g) => (g.paths ?? []).map((p) => new Bun.Glob(p)));
    const assigned: string[][] = groups.map(() => []);

    for (const path of canonicalPaths({ cwd, base, head })) {
        const claimants = globs.flatMap((list, gi) => (list.some((glob) => glob.match(path)) ? [gi] : []));

        if (claimants.length > 1) {
            problems.push(`path ${path} is claimed by groups ${claimants.map((g) => g + 1).join(", ")}`);
            continue;
        }

        if (claimants.length === 1) {
            assigned[claimants[0]].push(path);
            continue;
        }

        const touches = groupCommits.map((list) => list.filter((c) => c.paths.includes(path)).length);
        const best = Math.max(...touches);

        if (best > 0) {
            const winner = touches.lastIndexOf(best);
            assigned[winner].push(path);

            if (touches.filter((n) => n > 0).length > 1) {
                shared.push(`${path}: ${touches.join("/")} -> group ${winner + 1}`);
            }

            continue;
        }

        if (rest.length === 1) {
            assigned[rest[0]].push(path);
            continue;
        }

        problems.push(`path ${path} is placed by no rule (no paths glob, no listed commit touches it, no rest group)`);
    }

    assigned.forEach((paths, gi) => {
        if (paths.length === 0) {
            problems.push(`group ${gi + 1} (${groups[gi].message}) got no paths`);
        }
    });

    const plan = groups
        .map((g, gi) => [`COMMIT ${gi + 1}: ${g.message}`, "FILES:", ...assigned[gi].sort()].join("\n"))
        .join("\n\n");

    return { plan: `${plan}\n`, problems, shared, counts: assigned.map((p) => p.length) };
}

interface HeadEntry {
    mode: string;
    sha: string;
}

function treeEntries(cwd: string, ref: string): Map<string, HeadEntry> {
    const entries = new Map<string, HeadEntry>();

    for (const record of git(cwd, ["ls-tree", "-r", "-z", ref]).split("\0").filter(Boolean)) {
        const tab = record.indexOf("\t");
        const [mode, , sha] = record.slice(0, tab).split(" ");
        entries.set(record.slice(tab + 1), { mode: mode ?? "", sha: sha ?? "" });
    }

    return entries;
}

const ZERO = "0000000000000000000000000000000000000000";

/** Builds one commit per plan group on `base` in a throwaway index; returns the new SHAs. */
export function buildCommits({
    cwd,
    base,
    head,
    planText,
}: {
    cwd: string;
    base: string;
    head: string;
    planText: string;
}): string[] {
    const groups = parsePlan(planText);
    const entries = treeEntries(cwd, head);
    const scratch = mkdtempSync(join(tmpdir(), "recommit-"));
    const indexFile = join(scratch, "index");
    const shas: string[] = [];

    try {
        git(cwd, ["read-tree", base], { indexFile });
        let parent = base;

        for (const group of groups) {
            const lines = group.paths.map((path) => {
                const entry = entries.get(path);
                return entry ? `${entry.mode} ${entry.sha}\t${path}` : `0 ${ZERO}\t${path}`;
            });
            git(cwd, ["update-index", "--index-info"], { indexFile, input: `${lines.join("\n")}\n` });
            const tree = git(cwd, ["write-tree"], { indexFile }).trim();
            parent = git(cwd, ["commit-tree", tree, "-p", parent, "-m", group.message]).trim();
            shas.push(parent);
        }
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }

    return shas;
}

/** Proves each path changes exactly once, in its own group's commit, to head's exact entry. */
export function auditCommits({
    cwd,
    base,
    head,
    planText,
    shas,
}: {
    cwd: string;
    base: string;
    head: string;
    planText: string;
    shas: string[];
}): string[] {
    const problems: string[] = [];
    const groups = parsePlan(planText);
    const baseEntries = treeEntries(cwd, base);
    const headEntries = treeEntries(cwd, head);
    const snapshots = shas.map((sha) => treeEntries(cwd, sha));
    const show = (e: HeadEntry | undefined) => (e ? `${e.mode} ${e.sha.slice(0, 9)}` : "absent");
    const same = (a: HeadEntry | undefined, b: HeadEntry | undefined) => a?.mode === b?.mode && a?.sha === b?.sha;

    groups.forEach((group, gi) => {
        for (const path of group.paths) {
            for (let ci = 0; ci < snapshots.length; ci++) {
                const want = ci < gi ? baseEntries.get(path) : headEntries.get(path);
                const got = snapshots[ci].get(path);

                if (!same(want, got)) {
                    problems.push(
                        `${path}: commit ${ci + 1} has ${show(got)}, expected ${show(want)} (${ci < gi ? "base, before its group" : "final, from its group on"} ${gi + 1})`
                    );
                }
            }
        }
    });

    for (let ci = 0; ci < shas.length; ci++) {
        const parent = ci === 0 ? base : shas[ci - 1];
        const touched = git(cwd, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", parent, shas[ci]])
            .split("\0")
            .filter(Boolean);
        const own = new Set(groups[ci]?.paths ?? []);

        for (const path of touched.filter((p) => !own.has(p))) {
            problems.push(`commit ${ci + 1} changes ${path}, which belongs to another group`);
        }
    }

    return problems;
}

/** Runs `command` on every new commit in a throwaway worktree; returns the failures. */
function verifyEach({ cwd, shas, command }: { cwd: string; shas: string[]; command: string }): string[] {
    const failures: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "recommit-verify-"));
    const modules = join(git(cwd, ["rev-parse", "--show-toplevel"]).trim(), "node_modules");

    try {
        shas.forEach((sha, i) => {
            const dir = join(root, `c${i + 1}`);
            git(cwd, ["worktree", "add", "--detach", "--quiet", dir, sha]);

            try {
                if (existsSync(modules)) {
                    symlinkSync(modules, join(dir, "node_modules"));
                }

                const r = spawnSync("sh", ["-c", command], { cwd: dir, encoding: "utf8" });
                process.stderr.write(`verify-each commit ${i + 1} ${sha.slice(0, 9)}: exit ${r.status}\n`);

                if (r.status !== 0) {
                    failures.push(
                        `commit ${i + 1} ${sha.slice(0, 9)}: \`${command}\` exited ${r.status}\n${`${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-15).join("\n")}`
                    );
                }
            } finally {
                git(cwd, ["worktree", "remove", "--force", dir]);
            }
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }

    return failures;
}

/** "src/cmux(5), src/utils(1)": where a group's paths live, to spot a misplaced one. */
function areas(paths: string[]): string {
    const counts = new Map<string, number>();

    for (const path of paths) {
        const area = path
            .split("/")
            .slice(0, path.includes("/") ? 2 : 1)
            .join("/");
        counts.set(area, (counts.get(area) ?? 0) + 1);
    }

    return [...counts]
        .sort((a, b) => b[1] - a[1])
        .map(([area, n]) => `${area}(${n})`)
        .join(", ");
}

function stamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function main(argv: string[]): number {
    let args: Args;

    try {
        args = parseArgs(argv);
    } catch (error) {
        process.stderr.write(`${(error as Error).message}\n${USAGE}`);
        return 2;
    }

    const { cwd } = args;
    const head = git(cwd, ["rev-parse", "--verify", `${args.head}^{commit}`]).trim();
    const base = git(cwd, ["merge-base", args.base, head]).trim();
    process.stderr.write(
        `base ${base.slice(0, 9)} (merge-base of ${args.base} and ${args.head}), head ${head.slice(0, 9)}\n`
    );

    if (args.command === "log") {
        const commits = commitsBetween(cwd, base, head);

        for (const c of commits) {
            process.stdout.write(`${c.sha.slice(0, 9)} ${c.subject}\n${c.paths.map((p) => `    ${p}`).join("\n")}\n`);
        }

        process.stdout.write(
            `${commits.length} commits, ${canonicalPaths({ cwd, base, head }).length} canonical paths\n`
        );
        return 0;
    }

    if (args.command === "group") {
        if (!args.groups) {
            process.stderr.write(`group needs --groups\n${USAGE}`);
            return 2;
        }

        const result = groupPaths({ cwd, base, head, groups: readGroups(args.groups) });
        const out = args.out ?? args.groups.replace(/(\.json)?$/, ".plan.txt");
        writeFileSync(out, result.plan);

        for (const line of result.shared) {
            process.stderr.write(`shared ${line}\n`);
        }

        parsePlan(result.plan).forEach((g, i) => {
            process.stdout.write(`${i + 1}. ${String(result.counts[i]).padStart(4)} paths  ${g.message}\n`);
            process.stdout.write(`        areas: ${areas(g.paths)}\n`);
        });

        if (result.problems.length) {
            process.stderr.write(`✖ grouping is wrong:\n  ${result.problems.join("\n  ")}\n`);
            return 1;
        }

        const report = checkPlan({ cwd, base, head, groups: parsePlan(result.plan) });

        if (report.problems.length) {
            process.stderr.write(`✖ plan check:\n  ${report.problems.join("\n  ")}\n`);
            return 1;
        }

        process.stdout.write(`plan ${out}: ${report.groups} commits, ${report.paths} paths, tree identity OK\n`);
        return 0;
    }

    if (!args.plan) {
        process.stderr.write(`${args.command} needs --plan\n${USAGE}`);
        return 2;
    }

    const planText = readFileSync(args.plan, "utf8");
    const report = checkPlan({ cwd, base, head, groups: parsePlan(planText) });

    if (report.problems.length) {
        process.stderr.write(`✖ plan check:\n  ${report.problems.join("\n  ")}\n`);
        return 1;
    }

    if (args.command === "check") {
        process.stdout.write(`${report.groups} commits, ${report.paths} paths, tree identity OK\n`);
        return 0;
    }

    const shas = buildCommits({ cwd, base, head, planText });
    const tip = shas.at(-1) as string;
    const newTree = git(cwd, ["rev-parse", `${tip}^{tree}`]).trim();
    const oldTree = git(cwd, ["rev-parse", `${head}^{tree}`]).trim();

    if (newTree !== oldTree) {
        process.stderr.write(`✖ the new tip's tree ${newTree} is not head's ${oldTree}; nothing was moved\n`);
        return 1;
    }

    const audit = auditCommits({ cwd, base, head, planText, shas });

    if (audit.length) {
        process.stderr.write(`✖ per-path audit failed; nothing was moved:\n  ${audit.join("\n  ")}\n`);
        return 1;
    }

    if (args.verifyEach) {
        const failures = verifyEach({ cwd, shas, command: args.verifyEach });

        if (failures.length) {
            process.stderr.write(
                `✖ --verify-each failed on ${failures.length} commit(s); nothing was moved. Pin the paths the failing commit needs into its group with "paths", or merge the groups:\n${failures.join("\n\n")}\n`
            );
            return 1;
        }
    }

    process.stdout.write(
        `${git(cwd, ["log", "--oneline", `${base}..${tip}`])}tree identical to ${head.slice(0, 9)}; per-path audit OK${args.verifyEach ? `; --verify-each passed on ${shas.length} commits` : ""}\n`
    );
    const named = args.head === "HEAD" ? tryGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]) : args.head;
    const branch =
        args.branch ??
        (named && tryGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${named}`]) !== null ? named : null);

    if (args.dryRun || !branch) {
        process.stdout.write(
            `${args.dryRun ? "dry run" : "no branch named (pass --branch)"}: new tip ${tip}, nothing moved\n`
        );
        return 0;
    }

    const current = git(cwd, ["rev-parse", `refs/heads/${branch}`]).trim();

    if (current !== head) {
        process.stderr.write(
            `✖ ${branch} is at ${current.slice(0, 9)}, not the head ${head.slice(0, 9)} this plan was built from\n`
        );
        return 1;
    }

    const tag = `bkp/recommit/${branch.replaceAll("/", "-")}-${stamp()}`;
    git(cwd, ["tag", tag, head]);
    git(cwd, ["update-ref", "-m", "recommit", `refs/heads/${branch}`, tip, head]);
    process.stdout.write(
        `${branch}: ${head.slice(0, 9)} -> ${tip.slice(0, 9)} (${shas.length} commits). Backup tag ${tag}.\nUndo: git update-ref refs/heads/${branch} ${head} ${tip}\n`
    );
    return 0;
}

if (import.meta.main) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`✖ ${(error as Error).message}\n`);
        process.exitCode = 2;
    }
}
