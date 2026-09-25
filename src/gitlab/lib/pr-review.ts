/**
 * The reviewer's side of an MR: every fact a review of someone else's merge request needs, so the
 * reviewer reads code instead of assembling context. The MR, its diff with new-side (and old-side)
 * line numbers, the threads that already exist, my pending drafts, the other open MRs that break or
 * conflict when this one lands, and the configured gates. Read-only on GitLab and on git.
 *
 * `fetch-review` is the other direction (threads someone left on MY MR).
 */

import { existsSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { type ProjectApi, projectBase, restGet, restGetPaginated } from "@app/gitlab/lib/client";
import type { ReviewGate } from "@app/gitlab/lib/config";
import { gitResult } from "@app/gitlab/lib/git";
import { errorMessage, HttpError } from "@app/gitlab/lib/http";
import { pool } from "@app/gitlab/lib/pool";
import {
    type DiscussionSummary,
    type DraftSummary,
    fetchDiscussions,
    fetchDrafts,
} from "@app/gitlab/lib/review-drafts";
import { parseWorktreeList } from "@genesiscz/utils/git/porcelain";
import { logger } from "@genesiscz/utils/logger";

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffLine {
    kind: "+" | "-" | " ";
    /** Old-side number; null on an added line. */
    oldLine: number | null;
    /** New-side number; null on a removed line. Only `+` and context lines can anchor a new-side draft. */
    newLine: number | null;
    text: string;
}

export interface DiffHunk {
    header: string;
    oldStart: number;
    newStart: number;
    lines: DiffLine[];
}

export interface DiffFile {
    path: string;
    oldPath: string;
    status: FileStatus;
    binary: boolean;
    additions: number;
    deletions: number;
    hunks: DiffHunk[];
    /** GitLab collapsed the diff (too large); the hunks are missing, not empty. */
    truncated: boolean;
}

export interface AddedImport {
    path: string;
    newLine: number | null;
    specifier: string;
    text: string;
}

export interface ImpactEntry {
    iid: number;
    author: string;
    title: string;
    webUrl: string;
    /** Lines the other MR adds that import a module this MR deletes or renames. */
    imports: AddedImport[];
    /** Files both MRs change. */
    sharedFiles: string[];
}

export interface PrReviewGate {
    label: string;
    /** The configured command with `{files}` filled in. */
    command: string;
    /** The changed files the gate applies to (all changed files when the gate has no `when`). */
    files: string[];
}

export interface PrReviewFacts {
    provider: "gitlab";
    /** `https://gitlab.example.com` */
    host: string;
    /** `group/app`, from the MR's web URL even when the project was given as a numeric id. */
    project: string;
    iid: number;
    title: string;
    author: string;
    webUrl: string;
    sourceBranch: string;
    targetBranch: string;
    baseSha: string;
    startSha: string;
    headSha: string;
    /** Local checkout used for file links and the git diff; null when none was found. */
    repoPath: string | null;
    /** The worktree whose branch is the MR source branch; file links prefer it. */
    worktree: string | null;
    worktreeHead: string | null;
    /** `git` when both shas were in the local repository (with `contextLines`), else the GitLab diffs API. */
    diffSource: "git" | "api";
    files: DiffFile[];
    discussions: DiscussionSummary[];
    drafts: DraftSummary[];
    removedModules: string[];
    /** null = not scanned (`--no-impact` or the scan failed; see warnings). */
    impact: ImpactEntry[] | null;
    impactScanned: number;
    gates: PrReviewGate[];
    /** Partial failures: the facts are real, a part is missing. */
    warnings: string[];
}

const log = logger.child({ component: "gitlab/pr-review" });

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
const MODULE_EXTENSION = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/;

function newFile(path: string, oldPath: string): DiffFile {
    return {
        path,
        oldPath,
        status: "modified",
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
        truncated: false,
    };
}

function readFileHeader(file: DiffFile, raw: string): void {
    if (raw.startsWith("new file mode")) {
        file.status = "added";
    } else if (raw.startsWith("deleted file mode")) {
        file.status = "deleted";
    } else if (raw.startsWith("rename from ")) {
        file.oldPath = raw.slice("rename from ".length);
        file.status = "renamed";
    } else if (raw.startsWith("rename to ")) {
        file.path = raw.slice("rename to ".length);
        file.status = "renamed";
    } else if (raw.startsWith("--- a/")) {
        file.oldPath = raw.slice(6);
    } else if (raw.startsWith("+++ b/")) {
        file.path = raw.slice(6);
    } else if (raw.startsWith("Binary files ") || raw === "GIT binary patch") {
        file.binary = true;
    }
}

/**
 * `git diff` output as files and hunks. Every line carries its old- and new-side number; a
 * `\ No newline at end of file` marker is not a line.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
    const files: DiffFile[] = [];
    let file: DiffFile | null = null;
    let hunk: DiffHunk | null = null;
    let oldLine = 0;
    let newLine = 0;

    for (const raw of text.split("\n")) {
        if (raw.startsWith("diff --git ")) {
            const paths = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
            file = newFile(paths?.[2] ?? "", paths?.[1] ?? "");
            files.push(file);
            hunk = null;
            continue;
        }

        if (!file) {
            continue;
        }

        const header = HUNK_HEADER.exec(raw);

        if (header) {
            oldLine = Number(header[1]);
            newLine = Number(header[2]);
            hunk = { header: (header[3] ?? "").trim(), oldStart: oldLine, newStart: newLine, lines: [] };
            file.hunks.push(hunk);
            continue;
        }

        if (!hunk) {
            readFileHeader(file, raw);
            continue;
        }

        if (raw.startsWith("+")) {
            hunk.lines.push({ kind: "+", oldLine: null, newLine, text: raw.slice(1) });
            newLine++;
            file.additions++;
        } else if (raw.startsWith("-")) {
            hunk.lines.push({ kind: "-", oldLine, newLine: null, text: raw.slice(1) });
            oldLine++;
            file.deletions++;
        } else if (raw.startsWith(" ")) {
            hunk.lines.push({ kind: " ", oldLine, newLine, text: raw.slice(1) });
            oldLine++;
            newLine++;
        }
    }

    return files;
}

/** One entry of GitLab's `merge_requests/:iid/diffs` (or `changes`). */
export interface ApiDiff {
    old_path: string;
    new_path: string;
    new_file?: boolean;
    renamed_file?: boolean;
    deleted_file?: boolean;
    diff?: string;
    too_large?: boolean;
    collapsed?: boolean;
}

/** GitLab diff entries through the same parser, with paths and status from the entry's own fields. */
export function parseApiDiffs(entries: ApiDiff[]): DiffFile[] {
    return entries.map((entry) => {
        const body = entry.diff ?? "";
        const [parsed] = parseUnifiedDiff(`diff --git a/x b/x\n${body}`);
        const file = parsed ?? newFile(entry.new_path, entry.old_path);
        file.path = entry.new_path;
        file.oldPath = entry.old_path;
        file.status = entry.new_file
            ? "added"
            : entry.deleted_file
              ? "deleted"
              : entry.renamed_file
                ? "renamed"
                : "modified";
        file.truncated = Boolean(entry.too_large || (entry.collapsed && body === ""));
        file.binary = file.binary || (!file.truncated && body === "" && file.status !== "renamed");

        return file;
    });
}

/** The import strings that name a file: the path without its extension, and the folder for an `index` file. */
export function moduleSpecifiers(path: string): string[] {
    if (!MODULE_EXTENSION.test(path) || path.endsWith(".d.ts")) {
        return [];
    }

    const withoutExtension = path.replace(MODULE_EXTENSION, "");

    return posix.basename(withoutExtension) === "index"
        ? [withoutExtension, posix.dirname(withoutExtension)]
        : [withoutExtension];
}

/** Modules this MR deletes or renames away: an import of one in another MR breaks once this lands. */
export function removedModules(files: DiffFile[]): string[] {
    const gone = files.filter((file) => file.status === "deleted" || file.status === "renamed");

    return [...new Set(gone.flatMap((file) => moduleSpecifiers(file.oldPath)))].sort();
}

const IMPORT_HINT = /\b(import|from|require|export)\b/;
const QUOTED = /(['"`])([^'"`\n]+)\1/g;

/**
 * The module paths an import string can mean: a relative one resolved against the importing
 * file, a root-relative one as written, and an aliased one (`@/lib/x`, `~/lib/x`) without its alias.
 */
function importCandidates(importer: string, specifier: string): { exact: string[]; suffix: string[] } {
    if (specifier.startsWith(".")) {
        return { exact: [posix.normalize(posix.join(posix.dirname(importer), specifier))], suffix: [] };
    }

    const unaliased = /^[@~][^/]*\/(.+)$/.exec(specifier)?.[1];

    return { exact: [specifier], suffix: unaliased ? [unaliased] : [] };
}

/** Added lines that import one of `specifiers`, by relative path, root-relative path or alias. */
export function findAddedImports(files: DiffFile[], specifiers: string[]): AddedImport[] {
    const wanted = new Set(specifiers);
    const hits: AddedImport[] = [];

    if (wanted.size === 0) {
        return hits;
    }

    for (const file of files) {
        for (const hunk of file.hunks) {
            for (const line of hunk.lines) {
                if (line.kind !== "+" || !IMPORT_HINT.test(line.text)) {
                    continue;
                }

                for (const match of line.text.matchAll(QUOTED)) {
                    const { exact, suffix } = importCandidates(file.path, match[2]);
                    const specifier =
                        exact.find((candidate) => wanted.has(candidate)) ??
                        specifiers.find((known) => suffix.some((candidate) => known.endsWith(`/${candidate}`)));

                    if (specifier) {
                        hits.push({ path: file.path, newLine: line.newLine, specifier, text: line.text.trim() });
                        break;
                    }
                }
            }
        }
    }

    return hits;
}

/** How another open MR collides with this one; null when it does not. */
export function impactOf({
    other,
    otherFiles,
    specifiers,
    changedPaths,
}: {
    other: RawMergeRequest;
    otherFiles: DiffFile[];
    specifiers: string[];
    changedPaths: Set<string>;
}): ImpactEntry | null {
    const imports = findAddedImports(otherFiles, specifiers);
    const sharedFiles = otherFiles.map((file) => file.path).filter((path) => changedPaths.has(path));

    if (imports.length === 0 && sharedFiles.length === 0) {
        return null;
    }

    return {
        iid: other.iid,
        author: other.author?.username ?? "unknown",
        title: other.title,
        webUrl: other.web_url,
        imports,
        sharedFiles,
    };
}

/** Configured gates that apply to this diff; a gate with `when` appears only when a changed file matches it. */
export function selectGates(gates: ReviewGate[], files: DiffFile[]): PrReviewGate[] {
    const changed = files.filter((file) => file.status !== "deleted").map((file) => file.path);
    const selected: PrReviewGate[] = [];

    for (const gate of gates) {
        const when = gate.when ? new Bun.Glob(gate.when) : null;
        const matching = when ? changed.filter((path) => when.match(path)) : changed;

        if (when && matching.length === 0) {
            continue;
        }

        selected.push({
            label: gate.label,
            command: gate.command.replaceAll("{files}", matching.map(shellQuote).join(" ")),
            files: matching,
        });
    }

    return selected;
}

function shellQuote(value: string): string {
    return /^[\w./@:+=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

// ─── GitLab reads ──────────────────────────────────────────────────────────────

export interface RawMergeRequest {
    iid: number;
    title: string;
    web_url: string;
    source_branch: string;
    target_branch: string;
    sha: string;
    author?: { username?: string };
    diff_refs?: { base_sha?: string; start_sha?: string; head_sha?: string } | null;
}

const mrPath = (api: ProjectApi, iid: number): string => `${projectBase(api)}/merge_requests/${iid}`;

/** The MR's diff: `diffs` (GitLab 15.7+), falling back to `changes` on an older instance. */
export async function fetchMrDiffs(api: ProjectApi, iid: number): Promise<DiffFile[]> {
    try {
        return parseApiDiffs(await restGetPaginated<ApiDiff>(api, `${mrPath(api, iid)}/diffs`));
    } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) {
            throw error;
        }

        log.debug({ iid }, "diffs endpoint missing; using changes");
        const changed = await restGet<{ changes?: ApiDiff[] }>(api, `${mrPath(api, iid)}/changes`);

        return parseApiDiffs(changed.changes ?? []);
    }
}

/** `group/app` from `https://host/group/app/-/merge_requests/9`; the given project when the URL does not parse. */
export function projectPathOf(webUrl: string, fallback: string): string {
    try {
        const match = /^\/(.+?)\/(?:-\/)?merge_requests\/\d+/.exec(new URL(webUrl).pathname);

        return match?.[1] ?? fallback;
    } catch (error) {
        log.debug({ error, webUrl }, "MR web URL did not parse");

        return fallback;
    }
}

// ─── local git (read-only) ─────────────────────────────────────────────────────

function gitRaw(cwd: string, args: string[]): { stdout: string; ok: boolean; stderr: string } {
    try {
        const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });

        return { stdout: result.stdout.toString(), ok: result.exitCode === 0, stderr: result.stderr.toString() };
    } catch (error) {
        log.debug({ error, cwd, args }, "git spawn failed");

        return { stdout: "", ok: false, stderr: String(error) };
    }
}

function hasCommit(cwd: string, sha: string): boolean {
    return gitResult(cwd, ["cat-file", "-e", `${sha}^{commit}`]).exitCode === 0;
}

/**
 * The worktree whose checked-out branch is exactly `branch`. A substring test matched `feat/x`
 * inside `feat/x-2`, so the shared parser reads the list and the branch name is compared whole.
 */
export function findWorktree(repoPath: string, branch: string): string | null {
    const listed = gitResult(repoPath, ["worktree", "list", "--porcelain"]).stdout;

    return parseWorktreeList(listed).find((entry) => entry.branch === branch)?.path ?? null;
}

function localDiff({
    repoPath,
    baseSha,
    headSha,
    contextLines,
}: {
    repoPath: string;
    baseSha: string;
    headSha: string;
    contextLines: number;
}): DiffFile[] | null {
    if (!hasCommit(repoPath, baseSha) || !hasCommit(repoPath, headSha)) {
        log.debug({ repoPath, baseSha, headSha }, "shas not in the local repository; using the API diff");
        return null;
    }

    const diff = gitRaw(repoPath, [
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--find-renames",
        `-U${contextLines}`,
        baseSha,
        headSha,
    ]);

    if (!diff.ok) {
        log.debug({ repoPath, stderr: diff.stderr }, "git diff failed; using the API diff");
        return null;
    }

    return parseUnifiedDiff(diff.stdout);
}

// ─── collect ───────────────────────────────────────────────────────────────────

export interface CollectOptions {
    api: ProjectApi;
    iid: number;
    /** Local checkout for file links and the git diff; null reads everything from the API. */
    repoPath: string | null;
    /** Unchanged lines around each hunk when the diff comes from local git. */
    contextLines?: number;
    /** Scan other open MRs for imports of removed modules and shared files. */
    impact?: boolean;
    /** At most this many other open MRs get their diff read, the most recently updated first. */
    impactLimit?: number;
    gates?: ReviewGate[];
    concurrency?: number;
    onProgress?: (message: string) => void;
}

/** One diff request (or more) per other open MR: a busy project must not turn one review into hundreds. */
export const DEFAULT_IMPACT_LIMIT = 50;

async function scanOpenMrs({
    api,
    self,
    files,
    concurrency,
    limit,
    warnings,
}: {
    api: ProjectApi;
    self: RawMergeRequest;
    files: DiffFile[];
    concurrency: number;
    limit: number;
    warnings: string[];
}): Promise<{ entries: ImpactEntry[]; scanned: number }> {
    if (files.length === 0) {
        // No changed path to share and no module removed: no other MR can collide with this one.
        return { entries: [], scanned: 0 };
    }

    const open = await restGetPaginated<RawMergeRequest>(
        api,
        `${projectBase(api)}/merge_requests?state=opened&order_by=updated_at&sort=desc`
    );
    const candidates = open.filter((mr) => mr.iid !== self.iid && mr.source_branch !== self.target_branch);
    const others = candidates.slice(0, limit);
    const specifiers = removedModules(files);
    const changedPaths = new Set(files.map((file) => file.path));
    let scanned = 0;

    if (candidates.length > others.length) {
        warnings.push(
            `impact: partial, read the ${others.length} most recently updated of ${candidates.length} other open MRs (--impact-limit raises it)`
        );
    }

    const results = await pool(others, concurrency, async (other) => {
        try {
            const otherFiles = await fetchMrDiffs(api, other.iid);
            scanned++;

            return impactOf({ other, otherFiles, specifiers, changedPaths });
        } catch (error) {
            warnings.push(`impact: !${other.iid} diff unreadable (${errorMessage(error)})`);
            return null;
        }
    });

    const entries = results.filter((entry): entry is ImpactEntry => entry !== null);
    entries.sort(
        (a, b) => b.imports.length - a.imports.length || b.sharedFiles.length - a.sharedFiles.length || b.iid - a.iid
    );
    log.debug({ open: open.length, scanned, affected: entries.length }, "open MRs scanned");

    return { entries, scanned };
}

/** Everything a reviewer needs for one MR. Only GETs on GitLab; git is read (`diff`, `cat-file`, `worktree list`). */
export async function collectPrReviewFacts(options: CollectOptions): Promise<PrReviewFacts> {
    const { api, iid } = options;
    const progress = options.onProgress ?? (() => undefined);
    const warnings: string[] = [];
    const mr = await restGet<RawMergeRequest>(api, mrPath(api, iid));
    const baseSha = mr.diff_refs?.base_sha ?? "";
    const headSha = mr.diff_refs?.head_sha ?? mr.sha;
    progress(`!${iid} ${mr.title} (${mr.source_branch} → ${mr.target_branch}, head ${headSha.slice(0, 10)})`);

    const repoPath = options.repoPath && existsSync(options.repoPath) ? resolve(options.repoPath) : null;
    const worktree = repoPath ? findWorktree(repoPath, mr.source_branch) : null;
    const worktreeHead = worktree ? gitResult(worktree, ["rev-parse", "HEAD"]).stdout || null : null;

    if (repoPath && !worktree) {
        warnings.push(
            `no worktree has ${mr.source_branch} checked out; file links point at ${repoPath}, which is not the MR code`
        );
    } else if (worktree && worktreeHead !== headSha) {
        warnings.push(
            `worktree ${worktree} is at ${worktreeHead?.slice(0, 10)}, the MR head is ${headSha.slice(0, 10)}`
        );
    }

    const git =
        repoPath && baseSha ? localDiff({ repoPath, baseSha, headSha, contextLines: options.contextLines ?? 8 }) : null;
    const [files, discussions, drafts] = await Promise.all([
        git ? Promise.resolve(git) : fetchMrDiffs(api, iid),
        fetchDiscussions(api, String(iid)),
        fetchDrafts(api, String(iid)),
    ]);

    let impact: ImpactEntry[] | null = null;
    let impactScanned = 0;

    if (options.impact !== false) {
        progress("scanning other open MRs for imports of removed modules and shared files");

        try {
            const scan = await scanOpenMrs({
                api,
                self: mr,
                files,
                concurrency: options.concurrency ?? 4,
                limit: options.impactLimit ?? DEFAULT_IMPACT_LIMIT,
                warnings,
            });
            impact = scan.entries;
            impactScanned = scan.scanned;
        } catch (error) {
            warnings.push(`impact: open-MR scan failed (${errorMessage(error)})`);
        }
    }

    const facts: PrReviewFacts = {
        provider: "gitlab",
        host: api.host,
        project: projectPathOf(mr.web_url, api.project),
        iid,
        title: mr.title,
        author: mr.author?.username ?? "unknown",
        webUrl: mr.web_url,
        sourceBranch: mr.source_branch,
        targetBranch: mr.target_branch,
        baseSha,
        startSha: mr.diff_refs?.start_sha ?? baseSha,
        headSha,
        repoPath,
        worktree,
        worktreeHead,
        diffSource: git ? "git" : "api",
        files,
        discussions,
        drafts,
        removedModules: removedModules(files),
        impact,
        impactScanned,
        gates: selectGates(options.gates ?? [], files),
        warnings,
    };
    log.debug(
        {
            iid,
            project: facts.project,
            files: files.length,
            diffSource: facts.diffSource,
            discussions: discussions.length,
            drafts: drafts.length,
            impact: impact?.length ?? null,
            gates: facts.gates.length,
            warnings: warnings.length,
        },
        "pr review facts collected"
    );

    return facts;
}

/** The first line a draft can anchor on: the first added line, else the first hunk start. */
export function firstChangedLine(file: DiffFile): number | null {
    for (const hunk of file.hunks) {
        const added = hunk.lines.find((line) => line.kind === "+");

        if (added) {
            return added.newLine;
        }
    }

    return file.hunks[0]?.newStart ?? null;
}

/** Where file links point: the MR worktree, else the checkout, else nowhere. */
export function linkBase(facts: Pick<PrReviewFacts, "worktree" | "repoPath">): string | null {
    return facts.worktree ?? facts.repoPath;
}

/** A checkout folder above `path`, for `--repo` given as a file inside it. */
export function checkoutOf(path: string): string {
    const root = gitResult(existsSync(path) ? path : dirname(path), ["rev-parse", "--show-toplevel"]);

    return root.exitCode === 0 && root.stdout ? root.stdout : path;
}
