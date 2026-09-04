#!/usr/bin/env bun
/**
 * Rebase the checked-out branch onto <base-ref>, resolving every conflict from a tree you
 * already built and verified.
 *
 *   rebase-with-oracle.ts <oracle-ref> <base-ref> [--worktree <path>]
 *   rebase-with-oracle.ts --audit-only <pre-tip-ref> <base-ref> [--worktree <path>]
 *
 * At each stop, every conflicted file is overwritten with `git show <oracle-ref>:<file>`,
 * then the rebase continues (or skips the commit when that resolution left it empty).
 * <oracle-ref> is normally a tag that points at a TREE (`git tag oracle/<iid>
 * $(git write-tree)` taken from a resolved, verified `git merge --no-commit`). See
 * the gt:git skill, references/oracle-merge.md.
 *
 * Prints `STOP n @ sha — subject` and one line per file decision, caps at 150 stops, and
 * ends by comparing the final tree to the oracle. A conflicted file that does not exist in
 * the oracle is removed from the index and its working copy MOVED to <tmpdir>/rb-dropped/
 * (never deleted). No shell is involved: git runs through spawn with an argument array.
 *
 * Ends with two checks. (1) Tree: the final tree must equal the oracle. (2) A per-commit line
 * audit, pre-rebase tip vs result, matched by subject: DROPPED, SHRUNK, GROWN, NEW. The tree
 * check protects the END state; the audit protects the HISTORY. A commit that shrank a lot but
 * survived is the case to read: its residual is either genuine branch-only content that
 * belongs under another subject, or a hunk that applied "cleanly" and re-introduced old code a
 * later commit deletes again (a pair that cancels to nothing and should be dropped). Seen
 * 2026-09-04: 886 -> 28 and 311 -> 2 lines, the 2 being the undo of 2 of the 28, and the
 * 28-line commit did not compile (a duplicate declaration next to a parameter master already had).
 *
 * Third check, lost lines: every line (trimmed) that <pre-tip> had in a file the branch touched,
 * that neither HEAD nor <base-ref> has. Files the base never touched since the fork and still
 * lost lines are printed in full as LOST — nobody replaced that content. Files the base did
 * touch are counted only: a rewrite drops old lines legitimately (2026-09-04: 43 such files,
 * 588 lines, all in files merged PRs had rewritten; the named functions all still existed).
 *
 * `--audit-only <pre-tip-ref> <base-ref>` skips the rebase and runs the two audits between a
 * saved pre-rebase ref (a backup tag) and HEAD — "compare it with the state two rebases ago".
 *
 * Exit codes: 0 tree == oracle · 1 tree differs (read the diff before pushing) ·
 * 2 usage or precondition · 3 stop cap reached (rebase left in progress).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

interface GitResult {
    status: number;
    stdout: string;
    stderr: string;
}

/** spawnSync's default is 1 MiB; an overflow kills git and reads as "no such blob", which would drop a real file. */
const MAX_BUFFER = 1 << 28;

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): GitResult {
    const r = spawnSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        env: env ? { ...process.env, ...env } : process.env,
    });

    if (r.error) {
        throw r.error;
    }

    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Raw bytes, so a binary or CRLF file comes out of the oracle exactly as stored. */
function gitShowBytes(cwd: string, spec: string): Buffer | null {
    const r = spawnSync("git", ["-C", cwd, "show", spec], { maxBuffer: MAX_BUFFER });

    if (r.error) {
        throw r.error;
    }

    return r.status === 0 ? r.stdout : null;
}

interface CommitStat {
    sha: string;
    subject: string;
    files: number;
    lines: number;
}

/** One `git log --numstat` over a range → per-commit subject, file count and changed lines. */
function commitStats(cwd: string, range: string): CommitStat[] {
    const out: CommitStat[] = [];
    let cur: CommitStat | null = null;

    for (const line of git(cwd, ["log", "--reverse", "--format=%x01%h%x02%s", "--numstat", range]).stdout.split("\n")) {
        if (line.startsWith("\u0001")) {
            if (cur) {
                out.push(cur);
            }

            const [sha = "", subject = ""] = line.slice(1).split("\u0002");
            cur = { sha, subject, files: 0, lines: 0 };
            continue;
        }

        const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);

        if (m && cur) {
            cur.files += 1;
            cur.lines += (m[1] === "-" ? 0 : Number(m[1])) + (m[2] === "-" ? 0 : Number(m[2]));
        }
    }

    if (cur) {
        out.push(cur);
    }

    return out;
}

/** Per-file (+ins, -del) of one commit. */
function fileStats(cwd: string, sha: string): Map<string, { ins: number; del: number }> {
    const out = new Map<string, { ins: number; del: number }>();

    for (const line of git(cwd, ["show", "--numstat", "--format=", sha]).stdout.split("\n")) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);

        if (m) {
            out.set(m[3]!, { ins: m[1] === "-" ? 0 : Number(m[1]), del: m[2] === "-" ? 0 : Number(m[2]) });
        }
    }

    return out;
}

/** Added and removed lines (trimmed) of one commit in one file. */
function hunkLines(cwd: string, sha: string, file: string): { added: Set<string>; removed: Set<string> } {
    const added = new Set<string>();
    const removed = new Set<string>();

    for (const line of git(cwd, ["show", "--format=", "--no-renames", sha, "--", file]).stdout.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) {
            continue;
        }

        const body = line.slice(1).trim();

        if (body === "" || /^[{}();,]*$/.test(body)) {
            continue;
        }

        if (line.startsWith("+")) {
            added.add(body);
        } else if (line.startsWith("-")) {
            removed.add(body);
        }
    }

    return { added, removed };
}

/**
 * A later commit that, in every file it touches, removes exactly lines an earlier commit added
 * (and adds back what it removed) is the fingerprint of a hunk that applied "cleanly",
 * re-introduced old code, and was deleted again by the next replayed commit: the pair cancels
 * to nothing. Content is compared, not counts, so two unrelated one-line edits of the same file
 * do not pair. Only small commits are compared (both <= 400 lines), the range residuals live in.
 */
function cancelPairs(cwd: string, after: CommitStat[]): string[] {
    const notes: string[] = [];
    const small = after.filter((c) => c.lines > 0 && c.lines <= 400);
    const stats = new Map(small.map((c) => [c.sha, fileStats(cwd, c.sha)] as const));

    for (let i = 0; i < small.length; i++) {
        for (let j = i + 1; j < small.length; j++) {
            const x = stats.get(small[i]!.sha);
            const y = stats.get(small[j]!.sha);

            if (!x || !y || y.size === 0) {
                continue;
            }

            let reversed = 0;

            for (const [path, ys] of y) {
                const xs = x.get(path);

                if (!xs || xs.ins !== ys.del || xs.del !== ys.ins || ys.ins + ys.del === 0) {
                    continue;
                }

                const xl = hunkLines(cwd, small[i]!.sha, path);
                const yl = hunkLines(cwd, small[j]!.sha, path);
                const undone =
                    [...yl.removed].every((l) => xl.added.has(l)) && [...yl.added].every((l) => xl.removed.has(l));

                if (undone && yl.removed.size + yl.added.size > 0) {
                    reversed += 1;
                }
            }

            if (reversed === y.size) {
                notes.push(
                    `CANCEL?  ${small[j]!.sha} (${small[j]!.lines} lines) undoes exactly what ${small[i]!.sha} "${small[i]!.subject.slice(0, 50)}" did in ${reversed} file(s) — if both are residuals, drop both`
                );
            }
        }
    }

    return notes;
}

/**
 * Per-commit line audit: the pre-rebase history against the result, matched by subject in order
 * (a repeated subject matches its n-th occurrence). Prints every row that is not line-identical.
 */
function printLineAudit(cwd: string, base: string, preTip: string): number {
    const before = commitStats(cwd, `${base}..${preTip}`);
    const after = commitStats(cwd, `${base}..HEAD`);
    const seen = new Map<string, number>();
    const key = (c: CommitStat, counter: Map<string, number>): string => {
        const n = (counter.get(c.subject) ?? 0) + 1;
        counter.set(c.subject, n);
        return `${c.subject}\u0000${n}`;
    };
    const beforeByKey = new Map(before.map((c) => [key(c, seen), c] as const));
    const afterKeys = new Map<string, number>();
    const rows: string[] = [];
    const shrunk: CommitStat[] = [];
    const matched = new Set<string>();

    for (const c of after) {
        const k = key(c, afterKeys);
        const b = beforeByKey.get(k);

        if (!b) {
            rows.push(
                `NEW      ${"-".padStart(6)} -> ${String(c.lines).padEnd(6)} ${c.sha}  ${c.subject.slice(0, 70)}`
            );
            continue;
        }

        matched.add(k);

        if (c.lines === b.lines) {
            continue;
        }

        const tag =
            c.lines * 2 < b.lines || b.lines - c.lines >= 100 ? "SHRUNK" : c.lines > b.lines ? "GROWN" : "changed";
        rows.push(
            `${tag.padEnd(8)} ${String(b.lines).padStart(6)} -> ${String(c.lines).padEnd(6)} ${c.sha}  ${c.subject.slice(0, 70)}`
        );

        if (tag === "SHRUNK") {
            shrunk.push(c);
        }
    }

    for (const [k, b] of beforeByKey) {
        if (!matched.has(k)) {
            rows.push(
                `DROPPED  ${String(b.lines).padStart(6)} -> ${"-".padEnd(6)} ${b.sha}  ${b.subject.slice(0, 70)}`
            );
        }
    }

    process.stdout.write(`=== per-commit line audit: ${before.length} commits before, ${after.length} after ===\n`);

    if (rows.length === 0) {
        process.stdout.write("every surviving commit is line-identical to its pre-rebase self\n");
        return 0;
    }

    process.stdout.write(`${rows.join("\n")}\n`);

    for (const c of shrunk) {
        process.stdout.write(`--- residual of ${c.sha} (${c.lines} lines) ---\n`);
        process.stdout.write(git(cwd, ["show", "--stat", "--format=", c.sha]).stdout);
    }

    for (const note of cancelPairs(cwd, after)) {
        process.stdout.write(`${note}\n`);
    }

    if (shrunk.length > 0) {
        process.stdout.write(
            "READ each SHRUNK residual: branch-only content that belongs under a dropped commit's subject -> re-attribute it; " +
                "a hunk another residual deletes again -> the pair cancels, drop both; old code re-applied over the base's newer " +
                "version with no later undo -> the tree check above already failed, resolve it to the oracle.\n"
        );
    }

    return shrunk.length;
}

function fileLines(cwd: string, spec: string): Set<string> | null {
    const r = spawnSync("git", ["-C", cwd, "show", spec], { encoding: "utf8", maxBuffer: MAX_BUFFER });

    if (r.status !== 0) {
        return null;
    }

    const set = new Set<string>();

    for (const raw of r.stdout.split("\n")) {
        const line = raw.trim();

        if (line !== "" && !/^[{}();,]*$/.test(line)) {
            set.add(line);
        }
    }

    return set;
}

/**
 * Lines the pre-rebase tip had, in files the branch touched, that neither HEAD nor the base has
 * (trimmed, so a re-indent is not a loss). A file the base never touched since the fork and
 * that still lost lines is a real loss; a file the base rewrote is reported as a count only.
 */
function printLostLines(cwd: string, base: string, preTip: string): number {
    const mergeBase = git(cwd, ["merge-base", base, preTip]).stdout.trim();
    const files = git(cwd, ["diff", "--name-only", "--no-renames", mergeBase, preTip])
        .stdout.split("\n")
        .filter(Boolean);
    let realLoss = 0;
    let rewritten = 0;
    let rewrittenLines = 0;

    process.stdout.write(
        `=== lost-line check: ${files.length} branch-owned file(s), ${preTip.slice(0, 9)} vs HEAD, against ${base} ===\n`
    );

    for (const file of files) {
        const old = fileLines(cwd, `${preTip}:${file}`);

        if (!old) {
            continue;
        }

        const now = fileLines(cwd, `HEAD:${file}`) ?? new Set<string>();
        const onBase = fileLines(cwd, `${base}:${file}`) ?? new Set<string>();
        const lost = [...old].filter((l) => !now.has(l) && !onBase.has(l));

        if (lost.length === 0) {
            continue;
        }

        const baseTouched =
            Number(git(cwd, ["rev-list", "--count", `${mergeBase}..${base}`, "--", file]).stdout.trim()) || 0;

        if (baseTouched === 0) {
            realLoss += 1;
            process.stdout.write(
                `LOST     ${String(lost.length).padStart(5)} line(s)  ${file}   (the base never touched this file: nobody replaced them)\n`
            );

            for (const l of lost.slice(0, 8)) {
                process.stdout.write(`             ${l.slice(0, 110)}\n`);
            }

            if (lost.length > 8) {
                process.stdout.write(`             … ${lost.length - 8} more\n`);
            }
        } else {
            rewritten += 1;
            rewrittenLines += lost.length;
        }
    }

    process.stdout.write(
        `${realLoss} file(s) with real losses; ${rewritten} file(s) rewritten on the base since the fork dropped ${rewrittenLines} old line(s) (expected — read them only if a feature is missing).\n`
    );
    return realLoss;
}

function parseArgs(argv: string[]): { oracle: string; base: string; cwd: string; auditOnly: boolean } | null {
    const positional: string[] = [];
    let cwd = process.cwd();
    let auditOnly = false;

    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--worktree") {
            cwd = argv[++i] ?? "";
            continue;
        }

        if (argv[i] === "--audit-only") {
            auditOnly = true;
            continue;
        }

        positional.push(argv[i]!);
    }

    if (positional.length !== 2 || !cwd) {
        return null;
    }

    return { oracle: positional[0]!, base: positional[1]!, cwd, auditOnly };
}

function main(argv: string[]): number {
    const parsed = parseArgs(argv);

    if (!parsed) {
        process.stderr.write(
            "usage: rebase-with-oracle.ts <oracle-ref> <base-ref> [--worktree <path>]\n       rebase-with-oracle.ts --audit-only <pre-tip-ref> <base-ref> [--worktree <path>]\n"
        );
        return 2;
    }

    const { oracle, base, cwd, auditOnly } = parsed;

    if (auditOnly) {
        if (git(cwd, ["rev-parse", "--verify", "--quiet", `${oracle}^{commit}`]).status !== 0) {
            process.stderr.write(`::error:: ${oracle} does not resolve to a commit\n`);
            return 2;
        }

        const preTipRef = git(cwd, ["rev-parse", oracle]).stdout.trim();
        const shrunk = printLineAudit(cwd, base, preTipRef);
        const lost = printLostLines(cwd, base, preTipRef);
        return shrunk + lost > 0 ? 1 : 0;
    }
    const gitDir = git(cwd, ["rev-parse", "--absolute-git-dir"]);

    if (gitDir.status !== 0) {
        process.stderr.write(`::error:: ${cwd} is not a git work tree\n`);
        return 2;
    }

    const rebaseDir = join(gitDir.stdout.trim(), "rebase-merge");

    if (git(cwd, ["rev-parse", "--verify", "--quiet", `${oracle}^{tree}`]).status !== 0) {
        process.stderr.write(`::error:: ${oracle} does not resolve to a tree\n`);
        return 2;
    }

    if (git(cwd, ["status", "--porcelain"]).stdout.trim() !== "") {
        process.stderr.write("::error:: working tree is not clean; commit or stash first\n");
        return 2;
    }

    const oracleTree = git(cwd, ["rev-parse", `${oracle}^{tree}`]).stdout.trim();
    const preTip = git(cwd, ["rev-parse", "HEAD"]).stdout.trim();
    const quietEditor = { GIT_EDITOR: "true" };
    const started = git(cwd, ["rebase", "--empty=drop", base], quietEditor);

    // A rebase that never started (bad base, one already in progress) leaves no rebase dir, so
    // the loop below is skipped and the tree gate would compare HEAD against the oracle and
    // "pass" without a single commit having moved.
    if (started.status !== 0 && !existsSync(rebaseDir)) {
        process.stderr.write(`::error:: git rebase ${base} failed to start: ${started.stderr.trim()}\n`);
        return 2;
    }

    let stops = 0;

    while (existsSync(rebaseDir)) {
        stops += 1;

        if (stops > 150) {
            process.stdout.write("CAP REACHED at 150 stops; rebase left in progress for inspection\n");
            return 3;
        }

        let stoppedSha = "?";

        try {
            stoppedSha = readFileSync(join(rebaseDir, "stopped-sha"), "utf8").trim().slice(0, 9);
        } catch {
            // The merge backend always writes it; a missing file only costs the label.
        }

        const subject = git(cwd, ["log", "-1", "--format=%s", stoppedSha]).stdout.trim().slice(0, 72);
        const files = git(cwd, ["diff", "-z", "--name-only", "--diff-filter=U"]).stdout.split("\0").filter(Boolean);
        process.stdout.write(`STOP ${stops} @ ${stoppedSha} — ${subject}\n`);

        for (const file of files) {
            const bytes = gitShowBytes(cwd, `${oracle}:${file}`);

            if (bytes !== null) {
                writeFileSync(join(cwd, file), bytes);
                git(cwd, ["add", "--", file]);
                process.stdout.write(`    ${file} <- oracle\n`);
                continue;
            }

            const dropped = join(tmpdir(), "rb-dropped");
            mkdirSync(dropped, { recursive: true });
            git(cwd, ["rm", "-q", "--cached", "--", file]);
            renameSync(join(cwd, file), join(dropped, `${stops}-${basename(file)}`));
            process.stdout.write(`    ${file} <- not in oracle (removed; copy in ${dropped})\n`);
        }

        const empty = git(cwd, ["diff", "--cached", "--quiet", "HEAD"]).status === 0;

        if (empty) {
            process.stdout.write("    (resolution left this commit empty -> skip)\n");
            git(cwd, ["rebase", "--skip"], quietEditor);
        } else {
            git(cwd, ["rebase", "--continue"], quietEditor);
        }
    }

    const head = git(cwd, ["log", "--oneline", "-1"]).stdout.trim().slice(0, 80);
    const onTop = git(cwd, ["rev-list", "--count", `${base}..HEAD`]).stdout.trim();
    const headTree = git(cwd, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
    process.stdout.write(`=== rebase finished; stops=${stops} ===\n${head}\ncommits on top of ${base}: ${onTop}\n`);

    const treeOk = headTree === oracleTree;

    if (treeOk) {
        process.stdout.write("TREE == ORACLE (byte-identical)\n");
    } else {
        process.stdout.write("TREE != ORACLE — read this before pushing:\n");
        process.stdout.write(git(cwd, ["diff", "--stat", oracle, "HEAD^{tree}"]).stdout);
    }

    printLineAudit(cwd, base, preTip);
    printLostLines(cwd, base, preTip);
    return treeOk ? 0 : 1;
}

if (import.meta.main) {
    process.exit(main(process.argv.slice(2)));
}
