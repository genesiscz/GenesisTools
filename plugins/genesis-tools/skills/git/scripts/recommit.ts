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
 *          { "message": "fix(x): …", "body": "why…\n\nmore", "commits": ["abc1234", …],
 *            "paths": ["src/x/**", "a.ts"], "rest": true,
 *            "author": { "from": "<sha>" } | { "name": "…", "email": "…", "date": "…" } }
 *        all fields but `message` optional; `message` is the one-line subject, `body` may span
 *        lines. Each canonical path goes to: the group whose `paths`
 *        (exact or glob) claim it, else the group whose `commits` touch it most often (a tie goes
 *        to the LATER group and is reported as shared), else the one `rest` group. Fails on a
 *        path two groups claim by `paths`, a path no rule places, a commit listed twice or never
 *        (when any group lists commits), and an empty group. Author: `author.from` copies that
 *        commit's name, email and author date; without `author`, a group whose listed commits all
 *        have one author takes that author and the author date of the last of them, and a group
 *        with several prints a note and gets the current git user. The committer is always the
 *        current user. Writes the plan in the recommit-plan-check format (plus `AUTHOR:` and
 *        `BODY:` lines) and runs that check.
 * check  The same check as recommit-plan-check.ts --plan: no duplicates, nothing missing or
 *        extra, every step changes the tree, the last step is head's tree byte for byte; and
 *        every AUTHOR line parses as git will read it. A plan without AUTHOR or BODY lines is valid.
 * apply Checks the plan, then builds the commits in a temporary index on top of the merge-base
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
 * Tree entries are read only for the plan's paths, and no git output is ever cut: spawnSync's
 * 1 MiB default once cut a 1.5 MB `ls-tree -r` listing silently, and every path past the cut
 * became a deletion. A plan path with no entry in head is written as a deletion only when
 * base..head deletes it; any other missing entry stops `apply` before it builds anything.
 *
 * Exit codes: 0 ok · 1 the groups or the plan are wrong (details on stderr) · 2 usage or git error.
 */

import { spawnSync } from "node:child_process";
import {
    closeSync,
    existsSync,
    fstatSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    canonicalPaths,
    checkPlan,
    describeUnresolved,
    type EntryReader,
    formatAuthor,
    formatPlan,
    headIndexLines,
    must,
    type PlanAuthor,
    type PlanGroup,
    type PlanReport,
    parsePlan,
    runGit,
    type TreeEntry,
    treeEntries,
} from "./recommit-plan-check";

const USAGE = `usage:
  recommit.ts log   --base <ref> [--head <ref>] [-C <dir>]
  recommit.ts group --base <ref> [--head <ref>] --groups <groups.json> [--out <plan.txt>] [-C <dir>]
  recommit.ts check --base <ref> [--head <ref>] --plan <plan.txt> [-C <dir>]
  recommit.ts apply --base <ref> [--head <ref>] --plan <plan.txt> [--branch <name>] [--dry-run] [--verify-each "<cmd>"] [-C <dir>]
`;

class UsageError extends Error {}

/** Every call goes through `runGit`: no output limit, and a cut or killed git throws. */
function git(
    cwd: string,
    args: string[],
    opts: { input?: string; indexFile?: string; env?: Record<string, string> } = {}
): string {
    return must(runGit(args, { cwd, ...opts }), `git ${args.slice(0, 3).join(" ")}`);
}

function tryGit(cwd: string, args: string[]): string | null {
    const r = runGit(args, { cwd });
    return r.code === 0 ? r.stdout.trim() : null;
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
    author: PlanAuthor;
    paths: string[];
}

/** Subject, then the author's name, email and strict ISO date, which `GIT_AUTHOR_DATE` reads back. */
const SUBJECT_AND_AUTHOR = "%s%x00%an%x00%ae%x00%aI";

function readSubjectAndAuthor(fields: string[]): { subject: string; author: PlanAuthor } {
    const [subject = "", name = "", email = "", date = ""] = fields;
    return { subject, author: { name, email, date } };
}

function subjectAndAuthor(cwd: string, sha: string): { subject: string; author: PlanAuthor } {
    return readSubjectAndAuthor(
        git(cwd, ["log", "-1", `--format=${SUBJECT_AND_AUTHOR}`, sha])
            .replace(/\n$/, "")
            .split("\0")
    );
}

function commitsBetween(cwd: string, base: string, head: string): Commit[] {
    // One `git log` reads every subject and author, one line per commit (a subject never holds a newline); only the
    // paths still take a git call per commit.
    return git(cwd, ["log", "--reverse", `--format=%H%x00${SUBJECT_AND_AUTHOR}`, `${base}..${head}`])
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [sha = "", ...fields] = line.split("\0");

            return {
                sha,
                ...readSubjectAndAuthor(fields),
                paths: git(cwd, [
                    "diff-tree",
                    "-r",
                    "-z",
                    "--no-renames",
                    "--no-commit-id",
                    "--name-only",
                    "--root",
                    sha,
                ])
                    .split("\0")
                    .filter(Boolean),
            };
        });
}

type AuthorSpec = { from: string } | PlanAuthor;

interface GroupSpec {
    message: string;
    body?: string;
    author?: AuthorSpec;
    commits?: string[];
    paths?: string[];
    rest?: boolean;
}

const GROUP_FIELDS = ["message", "body", "author", "commits", "paths", "rest"];

function isLine(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== "" && !/[\n<>]/.test(value);
}

function readAuthorSpec(raw: unknown, where: string): AuthorSpec {
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        const keys = Object.keys(raw);
        const from = "from" in raw ? raw.from : undefined;
        const name = "name" in raw ? raw.name : undefined;
        const email = "email" in raw ? raw.email : undefined;
        const date = "date" in raw ? raw.date : undefined;

        if (keys.length === 1 && isLine(from)) {
            return { from };
        }

        if (keys.every((k) => ["name", "email", "date"].includes(k)) && isLine(name) && isLine(email)) {
            if (date === undefined) {
                return { name, email };
            }

            if (isLine(date)) {
                return { name, email, date };
            }
        }
    }

    throw new UsageError(`${where} must be { "from": "<sha>" } or { "name", "email", "date"? }, each one line`);
}

function readGroups(file: string): GroupSpec[] {
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));

    if (!Array.isArray(data) || data.length === 0) {
        throw new UsageError(`${file}: expected a non-empty JSON array of groups`);
    }

    return data.map((raw: unknown, i) => {
        const where = `${file}: groups[${i}]`;

        if (typeof raw !== "object" || raw === null) {
            throw new UsageError(`${where} must be an object`);
        }

        for (const key of Object.keys(raw)) {
            if (!GROUP_FIELDS.includes(key)) {
                throw new UsageError(`${where}.${key} is not a known field (${GROUP_FIELDS.join(", ")})`);
            }
        }

        const g = raw as GroupSpec;

        if (typeof g.message !== "string" || g.message.trim() === "" || g.message.includes("\n")) {
            throw new UsageError(`${where}.message must be one non-empty line`);
        }

        if (g.body !== undefined && typeof g.body !== "string") {
            throw new UsageError(`${where}.body must be a string (it may span lines)`);
        }

        const body = g.body?.trimEnd().replace(/^\n+/, "");
        const author = g.author === undefined ? undefined : readAuthorSpec(g.author, `${where}.author`);

        return { ...g, body: body || undefined, author };
    });
}

/**
 * A group's author: its `author` (copied from the `from` commit), else the one author of all
 * its listed commits with the author date of the last of them, else none (the current user).
 */
function groupAuthor({
    cwd,
    group,
    label,
    listed,
    order,
}: {
    cwd: string;
    group: GroupSpec;
    label: string;
    listed: Commit[];
    order: Commit[];
}): { author?: PlanAuthor; problem?: string; note?: string } {
    const spec = group.author;

    if (spec && "from" in spec) {
        const sha = tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${spec.from}^{commit}`]);
        return sha
            ? { author: subjectAndAuthor(cwd, sha).author }
            : { problem: `${label}: author.from ${spec.from} is not a commit` };
    }

    if (spec) {
        return { author: spec };
    }

    const idents = [...new Set(listed.map((c) => `${c.author.name} <${c.author.email}>`))];

    if (idents.length === 1) {
        const last = listed.reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a));
        return { author: last.author };
    }

    if (idents.length > 1) {
        return {
            note: `${label} lists commits by ${idents.length} authors (${idents.join(", ")}), so it keeps the current git user; set "author" to pick one`,
        };
    }

    return {};
}

/** `git var` parses an author the way `commit-tree` will, so a bad date fails before any commit exists. */
function authorProblems(cwd: string, groups: PlanGroup[]): string[] {
    return groups.flatMap((group) => {
        if (!group.author) {
            return [];
        }

        const r = runGit(["var", "GIT_AUTHOR_IDENT"], { cwd, env: authorEnv(group.author) });
        return r.code === 0 ? [] : [`group ${group.index}: author ${formatAuthor(group.author)}: ${r.stderr.trim()}`];
    });
}

/**
 * The whole `check`: `checkPlan` plus every AUTHOR line git must read. Prints the problems and returns null when the
 * plan fails, so `group`, `check` and `apply` cannot drift apart on what a valid plan is.
 */
function passedPlan({
    cwd,
    base,
    head,
    groups,
}: {
    cwd: string;
    base: string;
    head: string;
    groups: PlanGroup[];
}): PlanReport | null {
    const report = checkPlan({ cwd, base, head, groups });
    const problems = [...report.problems, ...authorProblems(cwd, groups)];

    if (problems.length) {
        process.stderr.write(`✖ plan check:\n  ${problems.join("\n  ")}\n`);
        return null;
    }

    return report;
}

function authorEnv(author: PlanAuthor): Record<string, string> {
    return {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        ...(author.date ? { GIT_AUTHOR_DATE: author.date } : {}),
    };
}

export interface GroupingResult {
    plan: string;
    problems: string[];
    shared: string[];
    counts: number[];
    /** Groups whose listed commits have several authors and that name no `author`. */
    notes: string[];
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

    const notes: string[] = [];
    const planGroups = groups.map((group, gi) => {
        const { author, problem, note } = groupAuthor({
            cwd,
            group,
            label: `group ${gi + 1} (${group.message})`,
            listed: groupCommits[gi],
            order: commits,
        });

        if (problem) {
            problems.push(problem);
        }

        if (note) {
            notes.push(note);
        }

        return { message: group.message, body: group.body, author, paths: assigned[gi].sort() };
    });

    return { plan: formatPlan(planGroups), problems, shared, counts: assigned.map((p) => p.length), notes };
}

/**
 * Builds one commit per plan group on `base` in a throwaway index; returns the new SHAs. Every
 * path is resolved before the first object is written, so a path whose entry lookup came back
 * empty while base..head does not delete it throws and leaves nothing behind. `readEntries` is
 * the lookup, replaceable in a test.
 */
export function buildCommits({
    cwd,
    base,
    head,
    planText,
    readEntries = treeEntries,
}: {
    cwd: string;
    base: string;
    head: string;
    planText: string;
    readEntries?: EntryReader;
}): string[] {
    const groups = parsePlan(planText);
    const index = headIndexLines({ cwd, base, head, paths: groups.flatMap((g) => g.paths), readEntries });

    if (index.unresolved.length > 0) {
        throw new Error(
            `no entry in head ${head.slice(0, 9)} for ${describeUnresolved({ cwd, head, paths: index.unresolved })}; a missing entry is never written as a deletion, so no commit was built`
        );
    }

    const scratch = mkdtempSync(join(tmpdir(), "recommit-"));
    const indexFile = join(scratch, "index");
    const shas: string[] = [];

    try {
        git(cwd, ["read-tree", base], { indexFile });
        let parent = base;

        for (const group of groups) {
            const lines = group.paths.flatMap((path) => index.lines.get(path) ?? []);
            git(cwd, ["update-index", "--index-info"], { indexFile, input: `${lines.join("\n")}\n` });
            const tree = git(cwd, ["write-tree"], { indexFile }).trim();
            const message = group.body ? ["-m", group.message, "-m", group.body] : ["-m", group.message];
            parent = git(cwd, ["commit-tree", tree, "-p", parent, ...message], {
                env: group.author ? authorEnv(group.author) : {},
            }).trim();
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
    const paths = groups.flatMap((g) => g.paths);
    const read = (ref: string) => treeEntries({ cwd, ref, paths });
    const baseEntries = read(base);
    const headEntries = read(head);
    const snapshots = shas.map(read);
    const show = (e: TreeEntry | undefined) => (e ? `${e.mode} ${e.sha.slice(0, 9)}` : "absent");
    const same = (a: TreeEntry | undefined, b: TreeEntry | undefined) => a?.mode === b?.mode && a?.sha === b?.sha;

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

/** The last `lines` lines of a log file, read from at most its last 64 KiB. */
function logTail(path: string, lines: number): string {
    const fd = openSync(path, "r");

    try {
        const size = fstatSync(fd).size;
        const tail = Buffer.alloc(Math.min(size, 64 * 1024));
        readSync(fd, tail, 0, tail.length, size - tail.length);
        return tail.toString("utf8").trim().split("\n").slice(-lines).join("\n");
    } finally {
        closeSync(fd);
    }
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

                // The output goes to a file, never into memory: a pipe past maxBuffer kills the command (a pass would
                // read as a failure), and an unlimited one holds a whole build log when the report keeps 15 lines.
                const log = join(root, `c${i + 1}.log`);
                const out = openSync(log, "w");
                // spawnSync reports a failed start in `r.error` instead of throwing, so the descriptor always closes.
                const r = spawnSync("sh", ["-c", command], { cwd: dir, stdio: ["ignore", out, out] });
                closeSync(out);
                const outcome = r.error ? `failed to run (${r.error.message})` : `exited ${r.status ?? r.signal}`;
                process.stderr.write(`verify-each commit ${i + 1} ${sha.slice(0, 9)}: ${outcome}\n`);

                if (r.error || r.status !== 0) {
                    failures.push(`commit ${i + 1} ${sha.slice(0, 9)}: \`${command}\` ${outcome}\n${logTail(log, 15)}`);
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

        for (const note of result.notes) {
            process.stderr.write(`note: ${note}\n`);
        }

        const planned = parsePlan(result.plan);

        planned.forEach((g, i) => {
            process.stdout.write(`${i + 1}. ${String(result.counts[i]).padStart(4)} paths  ${g.message}\n`);
            process.stdout.write(`        areas: ${areas(g.paths)}\n`);

            if (g.author) {
                process.stdout.write(`        author: ${formatAuthor(g.author)}\n`);
            }
        });

        if (result.problems.length) {
            process.stderr.write(`✖ grouping is wrong:\n  ${result.problems.join("\n  ")}\n`);
            return 1;
        }

        const report = passedPlan({ cwd, base, head, groups: planned });

        if (!report) {
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
    const planned = parsePlan(planText);
    const report = passedPlan({ cwd, base, head, groups: planned });

    if (!report) {
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
