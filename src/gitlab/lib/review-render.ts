import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type ProjectApi, projectBase, restGet, restGetPaginated, restGetText } from "@app/gitlab/lib/client";
import { classifyDivergence, type Divergence } from "@app/gitlab/lib/divergence";
import { fileLink } from "@app/gitlab/lib/file-link";
import { gitResult } from "@app/gitlab/lib/git";
import { errorMessage } from "@app/gitlab/lib/http";
import { fenceLanguage } from "@app/gitlab/lib/markdown";
import { type Block, type BlockInput, json2md } from "@genesiscz/utils/json2md";
import { logger } from "@genesiscz/utils/logger";

export interface Note {
    author?: { username?: string };
    body?: string;
    created_at?: string;
    resolvable?: boolean;
    resolved?: boolean;
    position?: {
        head_sha?: string;
        base_sha?: string;
        new_path?: string;
        old_path?: string;
        new_line?: number | null;
        old_line?: number | null;
    };
}

export interface Discussion {
    id?: string;
    individual_note?: boolean;
    notes?: Note[];
}

/** Diff-attached threads with at least one resolvable note still open. */
export function unresolvedThreads(discussions: Discussion[]): Discussion[] {
    return discussions.filter((d) => {
        if (d.individual_note) {
            return false;
        }

        const first = d.notes?.[0];
        if (!first?.resolvable || !first.position) {
            return false;
        }

        return !(d.notes ?? []).filter((n) => n.resolvable).every((n) => n.resolved);
    });
}

export function readLocalWindow(
    filePath: string,
    start: number,
    end: number
): { lines: string[]; total: number } | null {
    try {
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
            return null;
        }

        const all = readFileSync(filePath, "utf-8").split(/\r?\n/);
        const sliced = all.slice(Math.max(0, start - 1), Math.min(all.length, end));

        return { lines: sliced, total: all.length };
    } catch (error) {
        logger.debug({ error, filePath }, "gitlab: local window unreadable");

        return null;
    }
}

function numbered(lines: string[], start: number, anchorLine: number): string {
    const padWidth = String(start + lines.length).length;

    return lines
        .map((ln, i) => {
            const lineNo = start + i;
            const marker = lineNo === anchorLine ? "▶" : " ";

            return `${String(lineNo).padStart(padWidth)} ${marker} ${ln}`;
        })
        .join("\n");
}

function windowBlock(window: ReturnType<typeof readLocalWindow>, start: number, anchorLine: number): Block {
    if (!window) {
        return "_(file not in current working tree)_";
    }

    if (window.lines.length === 0) {
        return `_(file is ${window.total} lines; reviewer pointed at line ${anchorLine} which is past EOF)_`;
    }

    return { code: numbered(window.lines, start, anchorLine) };
}

function shortSha(sha: string | undefined): string {
    return sha ? sha.slice(0, 10) : "(none)";
}

function escapeMd(s: string): string {
    return s.replace(/\|/g, "\\|");
}

/** The MR tip: what would merge now, read by sha so the report does not depend on the checkout. */
export interface TipViews {
    sha: string;
    /** Path at the tip → its lines, or null when the file is not there. */
    views: Map<string, string[] | null>;
    /** `<head_sha>:<path>` → the path the file has at the tip, when it was renamed since. */
    renames: Map<string, string>;
    /** The checkout is on the MR: HEAD is the tip or descends from it, so a different file there is local work. */
    checkoutFollowsTip: boolean;
}

export interface RenderMarkdownOpts {
    mrIid: string;
    project: string;
    cwd: string;
    contextLines: number;
    /** `<head_sha>:<path>` → file lines at that sha. */
    anchorViews?: Map<string, string[]>;
    /** With the tip, each thread shows the tip and a divergence label, and the checkout only when it differs. */
    tip?: TipViews;
    /** Discussion id → its review id (`T03`, `Y01`). */
    refs?: Map<string, string>;
    /** Blocks placed after a thread's notes, inside its section (a judgement of the thread). */
    afterNotes?: (d: Discussion) => BlockInput;
    /** Extra bullets under "Next steps"; `{iid}` becomes the MR iid. */
    nextSteps?: string[];
}

export interface RenderMarkdownResult {
    md: string;
    threadCount: number;
    totalDiscussions: number;
    headShas: number;
    files: number;
}

export function threadStats(discussions: Discussion[]): { threads: number; headShas: number; files: number } {
    const threads = unresolvedThreads(discussions);
    const shas = new Set(threads.map((t) => t.notes?.[0]?.position?.head_sha).filter(Boolean));
    const files = new Set(
        threads.map((t) => t.notes?.[0]?.position?.new_path ?? t.notes?.[0]?.position?.old_path).filter(Boolean)
    );

    return { threads: threads.length, headShas: shas.size, files: files.size };
}

/** The reviewer's frozen view of one thread: the excerpt at its head_sha and whether the working tree still agrees. */
function frozenViewBlocks({
    pos,
    file,
    line,
    lo,
    hi,
    window,
    anchorViews,
}: {
    pos: NonNullable<Note["position"]>;
    file: string;
    line: number;
    lo: number;
    hi: number;
    window: ReturnType<typeof readLocalWindow>;
    anchorViews: Map<string, string[]>;
}): BlockInput {
    const heading = { h3: `Reviewer's frozen view at \`${shortSha(pos.head_sha)}\` (lines ${lo}–${hi}):` };
    const allLines = anchorViews.get(`${pos.head_sha}:${file}`);

    if (allLines === undefined) {
        return [heading, "_(fetch failed — see stderr)_"];
    }

    const sliced = allLines.slice(Math.max(0, lo - 1), Math.min(allLines.length, hi));
    const excerpt: Block =
        sliced.length === 0
            ? `_(file at ${shortSha(pos.head_sha)} is ${allLines.length} lines; line ${line} past EOF)_`
            : { code: numbered(sliced, lo, line) };
    const localOverlap = window?.lines.join("\n");
    const diverged = localOverlap !== undefined && localOverlap !== sliced.join("\n");

    return [
        heading,
        excerpt,
        {
            blockquote: diverged
                ? "⚠️ **Local working tree diverges from this view** — the line may have moved or been refactored. Read both before applying."
                : "✓ Local working tree matches this view at the anchor lines.",
        },
    ];
}

/** One note as `**@user** _(date)_:` over its quoted body; raw, because the two lines belong together. */
function noteBlock(note: Note): Block {
    const ts = note.created_at ? ` _(${note.created_at.slice(0, 10)})_` : "";
    const body = escapeMd(String(note.body ?? "").trim());

    return { raw: `**@${note.author?.username ?? "(unknown)"}**${ts}:\n> ${body.split("\n").join("\n> ")}` };
}

/** A window of `lines` around `anchor`, numbered, with ▶ on the anchor. */
function viewBlock(lines: string[], anchor: number, context: number, path: string): { range: string; block: Block } {
    const lo = Math.max(1, anchor - context);
    const hi = Math.min(lines.length, anchor + context);
    const sliced = lines.slice(lo - 1, hi);

    if (sliced.length === 0) {
        return {
            range: `line ${anchor}`,
            block: `_(the file has ${lines.length} lines; line ${anchor} is past its end)_`,
        };
    }

    return {
        range: `${lo}–${hi}`,
        block: { code: { content: numbered(sliced, lo, anchor), language: fenceLanguage(path) } },
    };
}

function readLocalFile(path: string): string[] | null {
    const window = readLocalWindow(path, 1, Number.MAX_SAFE_INTEGER);

    return window ? window.lines : null;
}

/** The divergence of one thread's anchor between the reviewer's view and the tip. */
export function threadDivergence(d: Discussion, opts: RenderMarkdownOpts): Divergence | null {
    const pos = d.notes?.[0]?.position;
    const tip = opts.tip;

    if (!pos || !tip || pos.new_line == null) {
        return null;
    }

    const path = pos.new_path ?? pos.old_path ?? "";
    const renamedTo = tip.renames.get(`${pos.head_sha}:${path}`);
    const tipLines = tip.views.get(renamedTo ?? path) ?? null;

    return classifyDivergence({
        reviewer: opts.anchorViews?.get(`${pos.head_sha}:${path}`) ?? null,
        tip: renamedTo ? null : tipLines,
        anchorLine: pos.new_line,
        window: opts.contextLines,
        renamedTo,
    });
}

function tipThreadBlocks(d: Discussion, idx: number, opts: RenderMarkdownOpts, tip: TipViews): BlockInput {
    const pos = d.notes?.[0]?.position;
    const file = pos?.new_path ?? pos?.old_path ?? "(unknown path)";
    const line = pos?.new_line ?? pos?.old_line ?? 0;
    const removedLine = pos?.new_line == null && pos?.old_line != null;
    const divergence = threadDivergence(d, opts);
    const tipPath = tip.renames.get(`${pos?.head_sha}:${file}`) ?? file;
    const tipLines = tip.views.get(tipPath) ?? null;
    const tipLine = divergence?.tipLine ?? divergence?.nearLine ?? line;
    const reviewerLines = opts.anchorViews?.get(`${pos?.head_sha}:${file}`) ?? null;
    const localPath = resolve(opts.cwd, tipPath);
    const localLines = readLocalFile(localPath);
    // A checkout on another branch holds another version, not local work on this MR.
    const localDiffers =
        tip.checkoutFollowsTip &&
        localLines !== null &&
        tipLines !== null &&
        localLines.join("\n") !== tipLines.join("\n");
    const noteCount = d.notes?.length ?? 0;
    const label = removedLine ? "comment on a removed line" : (divergence?.text ?? "unknown");
    const ref = (d.id && opts.refs?.get(d.id)) || `Thread ${idx + 1}`;
    const blocks: BlockInput[] = [
        { h2: `${ref} — \`${file}\`:${line} · ${label}` },
        {
            ul: [
                `**File**: ${fileLink(localPath, tipLine || null)}`,
                `**Discussion**: \`${d.id ?? "?"}\``,
                `**Divergence**: ${label}`,
                `**Reviewer's sha**: \`${shortSha(pos?.head_sha)}\` · **MR tip**: \`${shortSha(tip.sha)}\``,
            ],
        },
    ];

    if (tipLines === null) {
        blocks.push(
            { h3: `MR tip \`${shortSha(tip.sha)}\`` },
            `_(${file} is not at the tip${tipPath !== file ? `; it is ${tipPath} now` : ""})_`
        );
    } else {
        const view = viewBlock(tipLines, tipLine, opts.contextLines, tipPath);
        blocks.push({ h3: `MR tip \`${shortSha(tip.sha)}\` (lines ${view.range}):` }, view.block);
    }

    if (reviewerLines !== null && divergence?.label !== "unchanged") {
        const view = viewBlock(reviewerLines, line, opts.contextLines, file);
        blocks.push({ h3: `Reviewer's view at \`${shortSha(pos?.head_sha)}\` (lines ${view.range}):` }, view.block);
    }

    if (localDiffers && localLines !== null) {
        const view = viewBlock(localLines, tipLine, opts.contextLines, tipPath);
        blocks.push({ h3: `Local checkout, not pushed (lines ${view.range}):` }, view.block);
    }

    blocks.push(
        { h3: `Discussion (${noteCount} note${noteCount === 1 ? "" : "s"}):` },
        (d.notes ?? []).map(noteBlock),
        opts.afterNotes?.(d) ?? [],
        { hr: true }
    );

    return blocks;
}

function threadBlocks(d: Discussion, idx: number, opts: RenderMarkdownOpts): BlockInput {
    if (opts.tip) {
        return tipThreadBlocks(d, idx, opts, opts.tip);
    }

    const pos = d.notes?.[0]?.position;
    const file = pos?.new_path ?? pos?.old_path ?? "(unknown path)";
    const line = pos?.new_line ?? pos?.old_line ?? 0;
    const isDeletedLine = pos?.new_line == null && pos?.old_line != null;
    const lo = Math.max(1, line - opts.contextLines);
    const hi = line + opts.contextLines;
    const localPath = resolve(opts.cwd, file);
    const window = readLocalWindow(localPath, lo, hi);
    const noteCount = d.notes?.length ?? 0;

    return [
        {
            h2: `Thread ${idx + 1} — \`${file}\`:${line}${isDeletedLine ? " _(deleted line — comment on removed code)_" : ""}`,
        },
        {
            ul: [
                `**File**: ${fileLink(localPath, line || null)}`,
                `**Anchored at**: \`${shortSha(pos?.head_sha)}\` _(per-thread head_sha; **NOT** necessarily MR HEAD)_`,
                `**Base sha**: \`${shortSha(pos?.base_sha)}\``,
                `**Local state**: ${window ? `file is ${window.total} lines locally` : "file not in cwd"}`,
            ],
        },
        { h3: `Local working tree (lines ${lo}–${hi}):` },
        windowBlock(window, lo, line),
        opts.anchorViews && pos?.head_sha
            ? frozenViewBlocks({ pos, file, line, lo, hi, window, anchorViews: opts.anchorViews })
            : [],
        { h3: `Discussion (${noteCount} note${noteCount === 1 ? "" : "s"}):` },
        (d.notes ?? []).map(noteBlock),
        opts.afterNotes?.(d) ?? [],
        { hr: true },
    ];
}

/** The receive mode's compact view: one line per unresolved thread, with its id, anchor and divergence. */
export function receiveIndex(discussions: Discussion[], opts: RenderMarkdownOpts, command: string): string {
    const threads = unresolvedThreads(discussions);
    const lines = [
        `=== GitLab MR review received: ${opts.project}!${opts.mrIid} ===`,
        `Unresolved threads: ${threads.length} of ${discussions.length} discussions${opts.tip ? ` | MR tip ${shortSha(opts.tip.sha)}` : ""}`,
        "",
    ];

    threads.forEach((d, idx) => {
        const pos = d.notes?.[0]?.position;
        const first = d.notes?.[0];
        const ref = (d.id && opts.refs?.get(d.id)) || `thread${idx + 1}`;
        const removed = pos?.new_line == null && pos?.old_line != null;
        const label = removed ? "removed line" : (threadDivergence(d, opts)?.text ?? "unknown");
        const body = String(first?.body ?? "")
            .replace(/\s+/g, " ")
            .trim();

        lines.push(
            `  ${ref}  ${pos?.new_path ?? pos?.old_path ?? "?"}:${pos?.new_line ?? pos?.old_line ?? "?"}  @${first?.author?.username ?? "?"}  ${d.notes?.length ?? 0}n  ${label}  ${body.length > 60 ? `${body.slice(0, 59)}…` : body}`
        );
    });

    const sample = threads[0]?.id ? (opts.refs?.get(threads[0].id) ?? "T01") : "T01";
    lines.push("", `Expand: ${command} --expand ${sample}`, `Markdown: ${command} --md`);

    return `${lines.join("\n")}\n`;
}

/** The full sections of the chosen threads, by review id (`T03`) or discussion id prefix. */
export function expandThreads(discussions: Discussion[], opts: RenderMarkdownOpts, ids: string[]): string {
    const threads = unresolvedThreads(discussions);
    const wanted = ids.map((id) => id.trim()).filter(Boolean);
    const blocks: BlockInput[] = wanted.map((id) => {
        const index = threads.findIndex(
            (d) => (d.id && opts.refs?.get(d.id)?.toUpperCase() === id.toUpperCase()) || (d.id ?? "").startsWith(id)
        );
        const thread = threads[index];

        return thread ? threadBlocks(thread, index, opts) : `_${id}: no unresolved thread has this id._`;
    });

    return json2md(blocks);
}

/** One section per unresolved diff-attached thread: every note, the local window and the frozen view. */
export function threadSections(discussions: Discussion[], opts: RenderMarkdownOpts): BlockInput {
    return unresolvedThreads(discussions).map((d, idx) => threadBlocks(d, idx, opts));
}

/**
 * One section per thread given, resolved ones included: a diff-attached thread as `threadSections`
 * renders it, a top-level one as its notes.
 */
export function threadSectionsOf(threads: Discussion[], opts: RenderMarkdownOpts): BlockInput {
    return threads.map((d, idx) => {
        if (d.notes?.[0]?.position) {
            return threadBlocks(d, idx, opts);
        }

        const ref = (d.id && opts.refs?.get(d.id)) || `Thread ${idx + 1}`;
        const noteCount = d.notes?.length ?? 0;

        return [
            { h2: `${ref} — top-level` },
            { ul: [`**Discussion**: \`${d.id ?? "?"}\``] },
            { h3: `Discussion (${noteCount} note${noteCount === 1 ? "" : "s"}):` },
            (d.notes ?? []).map(noteBlock),
            opts.afterNotes?.(d) ?? [],
            { hr: true },
        ];
    });
}

/** Raw discussions plus the reviewer's frozen views, which `threadSections` renders. */
export async function collectThreadContext(options: {
    api: ProjectApi;
    iid: string;
    cwd: string;
    fetchRemote: boolean;
    onWarn: (msg: string) => void;
    /** The threads to read files for; default every unresolved one. */
    include?: (d: Discussion) => boolean;
}): Promise<{ discussions: Discussion[]; selected: Discussion[]; anchorViews: Map<string, string[]>; tip: TipViews }> {
    const discussions = await restGetPaginated<Discussion>(
        options.api,
        `${projectBase(options.api)}/merge_requests/${options.iid}/discussions`
    );
    const selected = options.include ? discussions.filter(options.include) : unresolvedThreads(discussions);
    // The tip first: its git fetch also brings in the reviewers' commits the checkout lacks.
    const tip = await fetchTipViews({ ...options, discussions, threads: selected });
    const { views } = await fetchAnchorViews({
        pairs: anchorPairsOf(selected),
        api: options.api,
        fetchRemote: options.fetchRemote,
        onWarn: options.onWarn,
        cwd: options.cwd,
    });

    return { discussions, selected, anchorViews: views, tip };
}

/** The fetch-review report as json2md blocks: header facts, one section per unresolved thread, next steps. */
export function reviewBlocks(discussions: Discussion[], opts: RenderMarkdownOpts): BlockInput {
    const threads = unresolvedThreads(discussions);
    const stats = threadStats(discussions);

    return [
        { h1: `GitLab MR ${opts.mrIid} review — unresolved threads` },
        {
            ul: [
                `**Project**: \`${opts.project}\``,
                `**Discussions total**: ${discussions.length}`,
                `**Unresolved diff-attached threads**: ${threads.length}`,
                `**Files touched**: ${stats.files}`,
                `**Distinct head_shas**: ${stats.headShas}  _(each comment may be anchored to a different commit — fetch / read at its own \`head_sha\`)_`,
                `**Local cwd**: \`${opts.cwd}\``,
            ],
        },
        { hr: true },
        threads.map((d, idx) => threadBlocks(d, idx, opts)),
        threads.length === 0 ? "_No unresolved diff-attached threads._" : [],
        { h2: "Next steps" },
        {
            ul: [
                "Apply the fixes to the current working tree (not to the reviewer's frozen view).",
                "Resolve threads in the GitLab UI after verifying.",
                ...(opts.nextSteps ?? []).map((step) => step.replaceAll("{iid}", opts.mrIid)),
            ],
        },
    ];
}

export function renderMarkdown(discussions: Discussion[], opts: RenderMarkdownOpts): RenderMarkdownResult {
    const threads = unresolvedThreads(discussions);
    const stats = threadStats(discussions);

    return {
        md: json2md(reviewBlocks(discussions, opts)),
        threadCount: threads.length,
        totalDiscussions: discussions.length,
        headShas: stats.headShas,
        files: stats.files,
    };
}

/** `<head_sha> <path>` of every unresolved diff-attached thread. */
export function collectUnresolvedAnchorPairs(discussions: Discussion[]): Set<string> {
    return anchorPairsOf(unresolvedThreads(discussions));
}

/** `<head_sha> <path>` of each of these threads that is attached to a diff line. */
export function anchorPairsOf(threads: Discussion[]): Set<string> {
    const pairs = new Set<string>();

    for (const d of threads) {
        const position = d.notes?.[0]?.position;
        const path = position?.new_path ?? position?.old_path;

        if (position?.head_sha && path) {
            pairs.add(`${position.head_sha} ${path}`);
        }
    }

    return pairs;
}

function hasCommit(cwd: string, sha: string): boolean {
    return gitResult(cwd, ["cat-file", "-e", `${sha}^{commit}`]).exitCode === 0;
}

/**
 * The tip's version of every file an unresolved thread names, read by sha. A commit missing from the
 * checkout is fetched once from `refs/merge-requests/<iid>/head`; the files API by sha is the last resort.
 */
export async function fetchTipViews(options: {
    api: ProjectApi;
    iid: string;
    cwd: string;
    discussions: Discussion[];
    /** The threads to read files for; default every unresolved one. */
    threads?: Discussion[];
    fetchRemote: boolean;
    onWarn: (msg: string) => void;
}): Promise<TipViews> {
    const mr = await restGet<{ sha: string }>(options.api, `${projectBase(options.api)}/merge_requests/${options.iid}`);
    const threads = options.threads ?? unresolvedThreads(options.discussions);
    const headShas = new Set(
        threads.map((t) => t.notes?.[0]?.position?.head_sha).filter((sha): sha is string => Boolean(sha))
    );
    const needed = [mr.sha, ...headShas];

    if (options.fetchRemote && needed.some((sha) => !hasCommit(options.cwd, sha))) {
        const fetched = gitResult(options.cwd, [
            "fetch",
            "--quiet",
            "origin",
            `refs/merge-requests/${options.iid}/head`,
        ]);

        if (fetched.exitCode !== 0) {
            options.onWarn(`git fetch of refs/merge-requests/${options.iid}/head failed; the files API fills in`);
        }
    }

    const renames = new Map<string, string>();

    for (const sha of headShas) {
        if (!hasCommit(options.cwd, sha) || !hasCommit(options.cwd, mr.sha)) {
            continue;
        }

        const listed = gitResult(options.cwd, ["diff", "-M", "--name-status", sha, mr.sha]);

        for (const row of listed.stdout.split("\n")) {
            const [status, from, to] = row.split("\t");

            if (status?.startsWith("R") && from && to) {
                renames.set(`${sha}:${from}`, to);
            }
        }
    }

    const paths = new Set<string>();

    for (const thread of threads) {
        const pos = thread.notes?.[0]?.position;
        const path = pos?.new_path ?? pos?.old_path;

        if (path) {
            paths.add(renames.get(`${pos?.head_sha}:${path}`) ?? path);
        }
    }

    const views = new Map<string, string[] | null>();

    await Promise.all(
        [...paths].map(async (path) => {
            const shown = gitResult(options.cwd, ["show", `${mr.sha}:${path}`]);

            if (shown.exitCode === 0) {
                views.set(path, shown.stdout.split(/\r?\n/));

                return;
            }

            if (hasCommit(options.cwd, mr.sha)) {
                views.set(path, null);

                return;
            }

            try {
                const text = await restGetText(
                    options.api,
                    `${projectBase(options.api)}/repository/files/${encodeURIComponent(path)}/raw?ref=${mr.sha}`
                );
                views.set(path, text.trim().split(/\r?\n/));
            } catch (error) {
                logger.debug({ error, path }, "gitlab: tip view not found");
                views.set(path, null);
            }
        })
    );

    const head = gitResult(options.cwd, ["rev-parse", "HEAD"]);
    const checkoutFollowsTip =
        head.exitCode === 0 &&
        (head.stdout === mr.sha ||
            gitResult(options.cwd, ["merge-base", "--is-ancestor", mr.sha, "HEAD"]).exitCode === 0);

    return { sha: mr.sha, views, renames, checkoutFollowsTip };
}

export interface AnchorFetchStats {
    views: Map<string, string[]>;
    gitHits: number;
    total: number;
}

/** The file as the reviewer saw it: `git show` first, the repository files API for shas not in local history. */
export async function fetchAnchorViews(options: {
    pairs: Set<string>;
    api: ProjectApi;
    fetchRemote: boolean;
    onWarn: (msg: string) => void;
    cwd: string;
}): Promise<AnchorFetchStats> {
    const views = new Map<string, string[]>();
    let gitHits = 0;
    const remaining: Array<{ sha: string; path: string }> = [];

    for (const key of options.pairs) {
        // Split at the FIRST space only: a sha has none, but a path may (`docs/release notes.md`),
        // and a full split cut it to `docs/release`, fetching the wrong file.
        const space = key.indexOf(" ");
        const sha = key.slice(0, space);
        const path = key.slice(space + 1);
        const shown = gitResult(options.cwd, ["show", `${sha}:${path}`]);

        if (shown.exitCode === 0) {
            views.set(`${sha}:${path}`, shown.stdout.split(/\r?\n/));
            gitHits++;
        } else {
            remaining.push({ sha, path });
        }
    }

    if (remaining.length > 0 && !options.fetchRemote) {
        options.onWarn(
            `git: ${gitHits} hit / ${remaining.length} miss — --no-anchors skipped the API fallback for the misses.`
        );
    } else if (remaining.length > 0) {
        options.onWarn(`git: ${gitHits} hit / ${remaining.length} miss — fetching the missing views from the API`);
        await Promise.all(
            remaining.map(async ({ sha, path }) => {
                try {
                    const text = await restGetText(
                        options.api,
                        `${projectBase(options.api)}/repository/files/${encodeURIComponent(path)}/raw?ref=${sha}`
                    );
                    views.set(`${sha}:${path}`, text.trim().split(/\r?\n/));
                } catch (error) {
                    options.onWarn(`Anchor fetch failed for ${path}@${sha.slice(0, 10)}: ${errorMessage(error)}`);
                }
            })
        );
    }

    return { views, gitHits, total: options.pairs.size };
}
