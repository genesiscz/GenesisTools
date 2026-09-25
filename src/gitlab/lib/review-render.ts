import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type ProjectApi, projectBase, restGetText } from "@app/gitlab/lib/client";
import { gitResult } from "@app/gitlab/lib/git";
import { errorMessage } from "@app/gitlab/lib/http";
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

export interface RenderMarkdownOpts {
    mrIid: string;
    project: string;
    cwd: string;
    contextLines: number;
    /** `<head_sha>:<path>` → file lines at that sha. */
    anchorViews?: Map<string, string[]>;
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

function threadBlocks(d: Discussion, idx: number, opts: RenderMarkdownOpts): BlockInput {
    const pos = d.notes?.[0]?.position;
    const file = pos?.new_path ?? pos?.old_path ?? "(unknown path)";
    const line = pos?.new_line ?? pos?.old_line ?? 0;
    const isDeletedLine = pos?.new_line == null && pos?.old_line != null;
    const lo = Math.max(1, line - opts.contextLines);
    const hi = line + opts.contextLines;
    const window = readLocalWindow(resolve(opts.cwd, file), lo, hi);
    const noteCount = d.notes?.length ?? 0;

    return [
        {
            h2: `Thread ${idx + 1} — \`${file}\`:${line}${isDeletedLine ? " _(deleted line — comment on removed code)_" : ""}`,
        },
        {
            ul: [
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
        { hr: true },
    ];
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
    const pairs = new Set<string>();

    for (const d of unresolvedThreads(discussions)) {
        const position = d.notes?.[0]?.position;
        const path = position?.new_path ?? position?.old_path;

        if (position?.head_sha && path) {
            pairs.add(`${position.head_sha} ${path}`);
        }
    }

    return pairs;
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
