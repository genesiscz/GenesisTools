import { type ProjectRef, parsePrRef, parsePrUrl, projectRefFromRemote } from "@genesiscz/utils/git/origins";
import { SafeJSON } from "@genesiscz/utils/json";
import { defineTransclusion, resolvePath, TransclusionError } from "../registry";
import type { TransclusionContext, TransclusionResult } from "../types";
import { codeBlock, firstLine, git } from "./shared";

type Json = Record<string, unknown>;

/** What a comment reference names: a review (diff) comment, a conversation comment, a review, or a GitLab note. */
export type CommentRef =
    | { kind: "review-comment"; id: string }
    | { kind: "issue-comment"; id: string }
    | { kind: "review"; id: string }
    | { kind: "note"; id: string }
    | { kind: "any"; id: string };

/** `discussion_r1`, `r1`, `issuecomment-1`, `pullrequestreview-1`, `note_1`, or a bare id. */
export function parseCommentRef(value: string): CommentRef | null {
    const trimmed = value.trim().replace(/^#/, "");
    const patterns: Array<[RegExp, CommentRef["kind"]]> = [
        [/^(?:discussion_)?r(\d+)$/, "review-comment"],
        [/^issuecomment-(\d+)$/, "issue-comment"],
        [/^(?:pullrequest)?review-(\d+)$/, "review"],
        [/^note_(\d+)$/, "note"],
        [/^(\d+)$/, "any"],
    ];

    for (const [pattern, kind] of patterns) {
        const match = pattern.exec(trimmed);

        if (match) {
            return { kind, id: match[1] };
        }
    }

    return null;
}

function record(value: unknown): Json {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function text(value: unknown): string {
    return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function login(value: unknown): string {
    const user = record(value);
    return text(user.login) || text(user.username) || "unknown";
}

const PAGE_SIZE = 100;
/** Pages read at most per list: 5000 comments or discussions, inside the token's own deadline. */
const MAX_PAGES = 50;

/**
 * Every item of a paged forge list, page by page until a short page or until `done` says the rest is
 * not needed. A list longer than MAX_PAGES is an error, never a partial page passed off as the whole.
 */
async function allPages({
    project,
    endpoint,
    ctx,
    done,
}: {
    project: ProjectRef;
    endpoint: string;
    ctx: TransclusionContext;
    done?: (items: Json[]) => boolean;
}): Promise<Json[]> {
    const items: Json[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
        const reply = await api({ project, endpoint: `${endpoint}?per_page=${PAGE_SIZE}&page=${page}`, ctx });
        const batch = Array.isArray(reply) ? reply.map(record) : [];
        items.push(...batch);

        if (batch.length < PAGE_SIZE || done?.(items)) {
            return items;
        }
    }

    throw new TransclusionError(`${endpoint} has more than ${MAX_PAGES * PAGE_SIZE} items; the thread was not read`);
}

async function api({
    project,
    endpoint,
    ctx,
}: {
    project: ProjectRef;
    endpoint: string;
    ctx: TransclusionContext;
}): Promise<unknown> {
    const binary = project.kind === "github" ? "gh" : "glab";
    const defaultHost = project.kind === "github" ? "github.com" : "gitlab.com";
    const hostArgs = project.host === defaultHost ? [] : ["--hostname", project.host];
    const result = await ctx.run([binary, "api", ...hostArgs, endpoint], { cwd: ctx.cwd, signal: ctx.signal });

    if (result.truncated) {
        throw new TransclusionError(`${binary} api ${endpoint} answered more than the 5 MB a token reads`);
    }

    if (result.code !== 0) {
        throw new TransclusionError(
            `${binary} api ${endpoint} failed: ${firstLine(result.stderr) || `exit ${result.code}`}`
        );
    }

    return SafeJSON.parse(result.stdout, { strict: true });
}

async function resolveProject(
    params: { url?: string; pr?: string },
    ctx: TransclusionContext
): Promise<{ project: ProjectRef; number: number; fragment?: string }> {
    const url = params.url ?? (params.pr && /^https?:\/\//i.test(params.pr) ? params.pr : undefined);

    if (url) {
        const parsed = parsePrUrl(url);

        if (!parsed) {
            throw new TransclusionError(`not a GitHub pull request or GitLab merge request URL: ${url}`);
        }

        const hash = new URL(url).hash.slice(1);
        return { ...parsed, ...(hash ? { fragment: hash } : {}) };
    }

    const bare = /^#?(\d+)$/.exec(params.pr?.trim() ?? "");
    const ref = bare ? { path: ctx.cwd, number: Number(bare[1]) } : parsePrRef(params.pr ?? "");

    if (!ref) {
        throw new TransclusionError(`cannot read pr="${params.pr}" (use owner/repo#12, #12 or a PR URL)`);
    }

    if ("url" in ref) {
        return resolveProject({ url: ref.url }, ctx);
    }

    const remote = await git(["remote", "get-url", "origin"], { cwd: resolvePath(ref.path, ctx.cwd), ctx });
    const project = remote.code === 0 ? projectRefFromRemote(remote.stdout.trim()) : null;

    if (!project) {
        throw new TransclusionError(`no GitHub or GitLab origin remote in ${ref.path}`);
    }

    return { project, number: ref.number };
}

function quoteComment({
    author,
    when,
    body,
    max,
}: {
    author: string;
    when: string;
    body: string;
    max: number;
}): string {
    const cut = body.length > max ? `${body.slice(0, max)}…` : body;
    const lines = cut.trim().split("\n");
    return [`> **@${author}**${when ? ` · ${when.slice(0, 10)}` : ""}`, ">", ...lines.map((line) => `> ${line}`)].join(
        "\n"
    );
}

async function githubThread({
    project,
    number,
    comment,
    max,
    ctx,
}: {
    project: ProjectRef;
    number: number;
    comment: CommentRef;
    max: number;
    ctx: TransclusionContext;
}): Promise<{ markdown: string; meta: Json; shown?: TransclusionResult["shown"] }> {
    const repo = `repos/${project.path}`;
    const tryFetch = async (endpoint: string): Promise<Json | null> => {
        try {
            return record(await api({ project, endpoint, ctx }));
        } catch (error) {
            if (comment.kind === "any") {
                ctx.logger.debug({ error, endpoint }, "pr-thread: not this comment kind, trying the next");
                return null;
            }

            throw error;
        }
    };

    if (comment.kind === "review-comment" || comment.kind === "any") {
        const root = await tryFetch(`${repo}/pulls/comments/${comment.id}`);

        if (root) {
            const rootId = text(root.in_reply_to_id) || text(root.id);
            // Every page: the thread's root or its replies may sit past the first hundred comments.
            const all = await allPages({ project, endpoint: `${repo}/pulls/${number}/comments`, ctx });
            const inThread = all.filter((item) => text(item.id) === rootId || text(item.in_reply_to_id) === rootId);
            // The fetched comment always belongs to its own thread, even when the list read missed it.
            const full = inThread.some((item) => text(item.id) === text(root.id)) ? inThread : [root, ...inThread];
            const thread = full.slice(0, max);
            const first = thread[0] ?? root;
            const hunk = text(first.diff_hunk).split("\n").slice(-8).join("\n");
            const where = `\`${text(first.path)}:${text(first.line) || text(first.original_line)}\``;
            const quotes = thread.map((item) =>
                quoteComment({
                    author: login(item.user),
                    when: text(item.created_at),
                    body: text(item.body),
                    max: 1200,
                })
            );
            return {
                markdown: [
                    where,
                    ...(hunk ? [codeBlock({ text: hunk, lang: "diff" })] : []),
                    quotes.join("\n>\n"),
                ].join("\n"),
                ...(full.length > max ? { shown: { shown: max, total: full.length, unit: "comments" } } : {}),
                meta: {
                    kind: "review-comment",
                    id: comment.id,
                    rootId,
                    comments: thread.length,
                    path: text(first.path),
                },
            };
        }
    }

    if (comment.kind === "issue-comment" || comment.kind === "any") {
        const item = await tryFetch(`${repo}/issues/comments/${comment.id}`);

        if (item) {
            return {
                markdown: quoteComment({
                    author: login(item.user),
                    when: text(item.created_at),
                    body: text(item.body),
                    max: 2000,
                }),
                meta: { kind: "issue-comment", id: comment.id },
            };
        }
    }

    if (comment.kind === "review") {
        const review = record(await api({ project, endpoint: `${repo}/pulls/${number}/reviews/${comment.id}`, ctx }));
        return {
            markdown: quoteComment({
                author: `${login(review.user)} (${text(review.state).toLowerCase() || "review"})`,
                when: text(review.submitted_at),
                body: text(review.body) || "(no summary text)",
                max: 2000,
            }),
            meta: { kind: "review", id: comment.id },
        };
    }

    throw new TransclusionError(`no comment ${comment.id} on ${project.path}#${number}`);
}

async function gitlabThread({
    project,
    number,
    comment,
    max,
    ctx,
}: {
    project: ProjectRef;
    number: number;
    comment: CommentRef;
    max: number;
    ctx: TransclusionContext;
}): Promise<{ markdown: string; meta: Json; shown?: TransclusionResult["shown"] }> {
    const base = `projects/${encodeURIComponent(project.path)}/merge_requests/${number}`;
    const holds = (discussion: Json) =>
        (Array.isArray(discussion.notes) ? discussion.notes.map(record) : []).some(
            (note) => text(note.id) === comment.id
        );
    // Page by page until the discussion holding the note turns up: a later one is never "no note".
    const list = await allPages({ project, endpoint: `${base}/discussions`, ctx, done: (items) => items.some(holds) });
    const found = list.find(holds);

    if (!found || !Array.isArray(found.notes)) {
        throw new TransclusionError(`no note ${comment.id} on ${project.path}!${number}`);
    }

    const notes = found.notes.map(record).slice(0, max);
    const position = record(notes[0]?.position);
    const where = text(position.new_path) ? `\`${text(position.new_path)}:${text(position.new_line)}\`\n` : "";
    const quotes = notes.map((note) =>
        quoteComment({ author: login(note.author), when: text(note.created_at), body: text(note.body), max: 1200 })
    );
    return {
        markdown: `${where}${quotes.join("\n>\n")}`,
        meta: { kind: "note", id: comment.id, comments: notes.length },
    };
}

export const prThreadTransclusion = defineTransclusion({
    name: "pr-thread",
    description:
        "A pull request (GitHub) or merge request (GitLab): its title, state and description, or with a " +
        "comment id the whole review thread with the diff hunk. Uses the gh / glab login already on the machine.",
    params: [
        {
            name: "url",
            type: "url",
            description: "A PR/MR URL; a #discussion_r…, #issuecomment-… or #note_… fragment picks the comment.",
        },
        {
            name: "pr",
            type: "string",
            description: "owner/repo#12, #12 (the cwd's origin) or a local checkout path#12.",
        },
        {
            name: "comment",
            type: "string",
            description: "discussion_r123, issuecomment-123, review-123, note_123 or a bare id.",
        },
        { name: "max", type: "int", default: 10, description: "The most comments of a thread to include." },
    ],
    requireOneOf: [["url", "pr"]],
    examples: [
        '{{pr-thread pr="genesiscz/GenesisTools#434"}}',
        '{{pr-thread url="https://github.com/genesiscz/GenesisTools/pull/434#discussion_r1234567"}}',
    ],
    action: "verify",
    async resolve(params, ctx) {
        const { project, number, fragment } = await resolveProject(
            { url: params.optionalString("url"), pr: params.optionalString("pr") },
            ctx
        );
        const commentText = params.optionalString("comment") ?? fragment;
        const comment = commentText ? parseCommentRef(commentText) : null;

        if (commentText && !comment) {
            throw new TransclusionError(
                `cannot read comment "${commentText}" (use discussion_r123, issuecomment-123 or 123)`
            );
        }

        const prEndpoint =
            project.kind === "github"
                ? `repos/${project.path}/pulls/${number}`
                : `projects/${encodeURIComponent(project.path)}/merge_requests/${number}`;
        const pr = record(await api({ project, endpoint: prEndpoint, ctx }));
        const webUrl = text(pr.html_url) || text(pr.web_url);
        const state = pr.merged === true || text(pr.merged_at) ? "merged" : text(pr.state);
        const author = login(project.kind === "github" ? pr.user : pr.author);
        const header = `**[${project.kind === "github" ? "PR" : "MR"} ${project.path}#${number}: ${text(pr.title).replace(/[[\]]/g, "")}](${webUrl})** · ${state} · @${author}`;
        const max = Math.max(1, params.int("max"));

        if (!comment) {
            const body = (text(pr.body) || text(pr.description)).trim();
            const cut = body.length > 1500 ? `${body.slice(0, 1500)}…` : body;
            return {
                markdown: [header, ...(cut ? ["", ...cut.split("\n").map((line) => `> ${line}`)] : [])].join("\n"),
                meta: { provider: project.kind, repo: project.path, number, state, url: webUrl },
                block: true,
                source: `${project.path}#${number} via ${project.kind === "github" ? "gh" : "glab"} api`,
            };
        }

        const thread =
            project.kind === "github"
                ? await githubThread({ project, number, comment, max, ctx })
                : await gitlabThread({ project, number, comment, max, ctx });
        return {
            markdown: `${header}\n\n${thread.markdown}`,
            meta: { provider: project.kind, repo: project.path, number, url: webUrl, ...thread.meta },
            block: true,
            source: `${project.path}#${number} comment ${comment.id} via ${project.kind === "github" ? "gh" : "glab"} api`,
            ...(thread.shown ? { shown: thread.shown } : {}),
        };
    },
});
