import { logger } from "@app/logger";
import { isBugFixSubject } from "./tokenize";
import type { RawCommit } from "./types";

/** Field/record separators unlikely to appear in commit metadata. */
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; ok: boolean }> {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (exitCode !== 0) {
        logger.debug(`git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`);
    }

    return { stdout, ok: exitCode === 0 };
}

/** True when {@link cwd} is inside a git work tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
    const { stdout, ok } = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
    return ok && stdout.trim() === "true";
}

/**
 * Pull bug-fix commits from git history.
 *
 * Subjects are classified with {@link isBugFixSubject}, so we over-fetch the
 * raw log and filter in-process (one deterministic classifier, reused by the
 * tests). For each surviving commit we fetch its name-only file list and a
 * size-bounded diff body.
 */
export async function collectBugFixCommits(opts: {
    cwd: string;
    since?: string;
    maxCommits: number;
    maxDiffBytesPerCommit: number;
}): Promise<RawCommit[]> {
    const { cwd, since, maxCommits, maxDiffBytesPerCommit } = opts;

    const logArgs = ["log", `--pretty=format:%h${FIELD_SEP}%s${FIELD_SEP}%aI${FIELD_SEP}%at${RECORD_SEP}`];
    if (since) {
        logArgs.push(`--since=${since}`);
    }

    const { stdout, ok } = await runGit(logArgs, cwd);
    if (!ok) {
        return [];
    }

    const records = stdout
        .split(RECORD_SEP)
        .map((r) => r.trim())
        .filter(Boolean);

    const bugFixes: RawCommit[] = [];
    for (const record of records) {
        const [hash, subject, date, atRaw] = record.split(FIELD_SEP);
        if (!hash || !subject) {
            continue;
        }

        if (!isBugFixSubject(subject)) {
            continue;
        }

        const timestamp = Number.parseInt(atRaw ?? "0", 10) || 0;
        bugFixes.push({ hash, subject, date: date ?? "", timestamp, files: [], diffLines: [] });

        if (bugFixes.length >= maxCommits) {
            break;
        }
    }

    for (const commit of bugFixes) {
        commit.files = await fetchChangedFiles(commit.hash, cwd);
        commit.diffLines = await fetchDiffLines(commit.hash, cwd, maxDiffBytesPerCommit);
    }

    logger.debug(`collected ${bugFixes.length} bug-fix commits from ${cwd}`);
    return bugFixes;
}

async function fetchChangedFiles(hash: string, cwd: string): Promise<string[]> {
    const { stdout, ok } = await runGit(["show", "--no-color", "--name-only", "--pretty=format:", hash], cwd);
    if (!ok) {
        return [];
    }

    return stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
}

async function fetchDiffLines(hash: string, cwd: string, maxBytes: number): Promise<string[]> {
    const { stdout, ok } = await runGit(["show", "--no-color", "--unified=0", "--pretty=format:", hash], cwd);
    if (!ok) {
        return [];
    }

    return extractDiffContentLines(stdout.slice(0, maxBytes));
}

/**
 * Keep only added/removed content lines from a unified diff, stripping the
 * leading `+`/`-`, and dropping the `+++`/`---` file headers and `@@` hunk
 * markers. Exported for unit testing.
 */
export function extractDiffContentLines(diff: string): string[] {
    const lines: string[] = [];
    for (const raw of diff.split("\n")) {
        if (raw.startsWith("+++") || raw.startsWith("---")) {
            continue;
        }

        if (raw.startsWith("+") || raw.startsWith("-")) {
            const content = raw.slice(1).trim();
            if (content) {
                lines.push(content);
            }
        }
    }

    return lines;
}

/** Read the staged diff (`git diff --cached`). */
export async function readStagedDiff(cwd: string): Promise<string> {
    const { stdout } = await runGit(["diff", "--cached", "--no-color"], cwd);
    return stdout;
}

/** Read the unstaged working-tree diff (`git diff`). */
export async function readWorkingDiff(cwd: string): Promise<string> {
    const { stdout } = await runGit(["diff", "--no-color"], cwd);
    return stdout;
}

/** Resolve the absolute top level of the repo containing {@link cwd}. */
export async function repoToplevel(cwd: string): Promise<string> {
    const { stdout, ok } = await runGit(["rev-parse", "--show-toplevel"], cwd);
    return ok ? stdout.trim() : cwd;
}
