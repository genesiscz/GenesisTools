import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type ProjectApi, projectBase, restGetText } from "@app/gitlab/lib/client";
import { gitResult } from "@app/gitlab/lib/git";
import { errorMessage } from "@app/gitlab/lib/http";
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

function renderWindow(window: ReturnType<typeof readLocalWindow>, start: number, anchorLine: number): string {
    if (!window) {
        return "_(file not in current working tree)_";
    }

    if (window.lines.length === 0) {
        return `_(file is ${window.total} lines; reviewer pointed at line ${anchorLine} which is past EOF)_`;
    }

    return `\`\`\`\n${numbered(window.lines, start, anchorLine)}\n\`\`\``;
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

export function renderMarkdown(discussions: Discussion[], opts: RenderMarkdownOpts): RenderMarkdownResult {
    const threads = unresolvedThreads(discussions);
    const stats = threadStats(discussions);

    const out: string[] = [];
    out.push(`# GitLab MR ${opts.mrIid} review — unresolved threads`);
    out.push("");
    out.push(`- **Project**: \`${opts.project}\``);
    out.push(`- **Discussions total**: ${discussions.length}`);
    out.push(`- **Unresolved diff-attached threads**: ${threads.length}`);
    out.push(`- **Files touched**: ${stats.files}`);
    out.push(
        `- **Distinct head_shas**: ${stats.headShas}  _(each comment may be anchored to a different commit — fetch / read at its own \`head_sha\`)_`
    );
    out.push(`- **Local cwd**: \`${opts.cwd}\``);
    out.push("");
    out.push("---");
    out.push("");

    for (const [idx, d] of threads.entries()) {
        const first = d.notes?.[0];
        const pos = first?.position;
        const file = pos?.new_path ?? pos?.old_path ?? "(unknown path)";
        const line = pos?.new_line ?? pos?.old_line ?? 0;
        const isDeletedLine = pos?.new_line == null && pos?.old_line != null;
        const lo = Math.max(1, line - opts.contextLines);
        const hi = line + opts.contextLines;
        const window = readLocalWindow(resolve(opts.cwd, file), lo, hi);
        const localTotalNote = window ? `file is ${window.total} lines locally` : "file not in cwd";

        out.push(
            `## Thread ${idx + 1} — \`${file}\`:${line}${isDeletedLine ? " _(deleted line — comment on removed code)_" : ""}`
        );
        out.push("");
        out.push(
            `- **Anchored at**: \`${shortSha(pos?.head_sha)}\` _(per-thread head_sha; **NOT** necessarily MR HEAD)_`
        );
        out.push(`- **Base sha**: \`${shortSha(pos?.base_sha)}\``);
        out.push(`- **Local state**: ${localTotalNote}`);
        out.push("");
        out.push(`### Local working tree (lines ${lo}–${hi}):`);
        out.push("");
        out.push(renderWindow(window, lo, line));
        out.push("");

        if (opts.anchorViews && pos?.head_sha) {
            const allLines = opts.anchorViews.get(`${pos.head_sha}:${file}`);
            out.push(`### Reviewer's frozen view at \`${shortSha(pos.head_sha)}\` (lines ${lo}–${hi}):`);
            out.push("");

            if (allLines === undefined) {
                out.push("_(fetch failed — see stderr)_");
                out.push("");
            } else {
                const sliced = allLines.slice(Math.max(0, lo - 1), Math.min(allLines.length, hi));

                if (sliced.length === 0) {
                    out.push(
                        `_(file at ${shortSha(pos.head_sha)} is ${allLines.length} lines; line ${line} past EOF)_`
                    );
                } else {
                    out.push("```");
                    out.push(numbered(sliced, lo, line));
                    out.push("```");
                }

                const localOverlap = window?.lines.join("\n");
                const diverged = localOverlap !== undefined && localOverlap !== sliced.join("\n");
                out.push("");
                out.push(
                    diverged
                        ? "> ⚠️ **Local working tree diverges from this view** — the line may have moved or been refactored. Read both before applying."
                        : "> ✓ Local working tree matches this view at the anchor lines."
                );
                out.push("");
            }
        }

        out.push(`### Discussion (${d.notes?.length ?? 0} note${d.notes?.length === 1 ? "" : "s"}):`);
        out.push("");

        for (const n of d.notes ?? []) {
            const u = n.author?.username ?? "(unknown)";
            const ts = n.created_at ? ` _(${n.created_at.slice(0, 10)})_` : "";
            const body = escapeMd(String(n.body ?? "").trim());
            out.push(`**@${u}**${ts}:`);
            out.push(`> ${body.split("\n").join("\n> ")}`);
            out.push("");
        }

        out.push("---");
        out.push("");
    }

    if (threads.length === 0) {
        out.push("_No unresolved diff-attached threads._");
        out.push("");
    }

    out.push("## Next steps");
    out.push("");
    out.push("- Apply the fixes to the current working tree (not to the reviewer's frozen view).");
    out.push("- Resolve threads in the GitLab UI after verifying.");
    out.push("");

    return {
        md: out.join("\n"),
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
        const [sha = "", path = ""] = key.split(" ");
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
