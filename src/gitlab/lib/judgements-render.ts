/**
 * `review render`: the judgements file plus the MR as it is now, as the report a person reads.
 *
 * - Full layout: every judged item with its code (the thread's tip view, the draft's or the finding's
 *   diff excerpt), the comment quoted in full, and the judgement under it.
 * - Digest: one card per item (quoted comment in full, verdict, 💡, the exact text that would be posted);
 *   a blocker or should-fix finding keeps its full block with the excerpt.
 * - `--item`: chosen items in the full layout.
 * - `--proposal`: the review proposal JSON for the GenesisTools review window.
 *
 * Quoted comments (`>`) are never shortened. Text meant to be copied or posted is a fenced block whose
 * lines are indented by three spaces; the indent is display-only, `comments post` reads the judgements
 * file itself.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { hostnameOf } from "@app/gitlab/lib/client";
import { fileLink } from "@app/gitlab/lib/file-link";
import {
    actionTextField,
    badgeOf,
    isJudged,
    type JudgementItem,
    type Judgements,
    parseAnchor,
    verdictOf,
} from "@app/gitlab/lib/judgements";
import type { KnownItem } from "@app/gitlab/lib/judgements-check";
import { fenceLanguage } from "@app/gitlab/lib/markdown";
import type { DiffFile } from "@app/gitlab/lib/pr-review";
import { draftExcerpt } from "@app/gitlab/lib/pr-review-output";
import type { DiscussionSummary, DraftSummary } from "@app/gitlab/lib/review-drafts";
import {
    type Discussion,
    type RenderMarkdownOpts,
    threadDivergence,
    threadSectionsOf,
} from "@app/gitlab/lib/review-render";
import { type BlockInput, json2md } from "@genesiscz/utils/json2md";

export interface RenderContext {
    iid: number;
    mode: "receive" | "give";
    mr: {
        host: string;
        project: string;
        title: string;
        webUrl: string;
        sourceBranch: string;
        targetBranch: string;
        headSha: string;
        baseSha: string;
    };
    /** The checkout file links point into. */
    repoPath: string;
    known: KnownItem[];
    /** Raw discussions by id, for the quoted notes and the tip views. */
    threads: Map<string, Discussion>;
    /** Tip views, reviewer views and refs for the threads; null renders threads without code. */
    threadOpts: RenderMarkdownOpts | null;
    drafts: DraftSummary[];
    /** Every discussion on the MR, resolved ones too: the proposal carries each with its real state. */
    discussions: DiscussionSummary[];
    /** The MR diff, for draft and finding excerpts; null leaves them out. */
    files: DiffFile[] | null;
    /** Who signs an answer in my own thread: `[90%] <agent>: …`. */
    agent: string;
    /** Lines of code on each side of an anchor in an excerpt; default 10, the least a review layout shows. */
    contextLines?: number;
}

// ─── text helpers ──────────────────────────────────────────────────────────────

/** `>` on every line, nothing dropped; an empty line stays inside the quote. */
export function quote(text: string): string {
    return text
        .trim()
        .split("\n")
        .map((line) => (line.trim() ? `> ${line}` : ">"))
        .join("\n");
}

/**
 * A fenced copy block whose lines are indented by three spaces (display-only). The shared code block
 * grows its fence past any backtick run inside, so a code sample in the text cannot close it early.
 */
export function copyBlock(text: string, language = "markdown"): string {
    const body = text
        .split("\n")
        .map((line) => (line ? `   ${line}` : ""))
        .join("\n");

    return json2md({ code: { content: body, language } }).trimEnd();
}

const PATH_LINE = /(?<![\w/.@-])((?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z0-9]+):(\d+)\b/g;

/** Each `path:line` of a file in the checkout becomes a clickable link; the rest stays as written. */
export function linkify(text: string, repoPath: string): string {
    return text.replace(PATH_LINE, (whole, path: string, line: string) => {
        const abs = join(repoPath, path);

        return existsSync(abs) ? fileLink(abs, Number(line)) : whole;
    });
}

/** The text an item's action sends, signed for an answer in my own thread. */
export function postedText(item: JudgementItem, agent: string): string | null {
    const action = (item.fields.get("Action") ?? "").trim();
    const field = actionTextField(item.kind, action);
    const text = field ? item.fences.get(field)?.trim() : undefined;

    if (!text) {
        return null;
    }

    return field === "Proposed answer" ? signedAnswer(item, text, agent) : text;
}

/** An answer in my own thread, signed with the answer's badge: `[90%] Opus: …`. */
export function signedAnswer(item: JudgementItem, text: string, agent: string): string {
    const badge = badgeOf(item.fields.get("Answer to the comment")) ?? badgeOf(verdictOf(item));

    return `${badge === null ? "" : `[${badge}%] `}${agent}: ${text}`;
}

// ─── item parts ────────────────────────────────────────────────────────────────

const VERB: Record<string, string> = {
    reply: "Reply",
    "reply-resolve": "Reply and resolve",
    keep: "Keep the draft",
    reword: "Reword the draft",
    move: "Move the draft",
    delete: "Delete the draft",
    comment: "Post a new draft",
    none: "Nothing to post",
};

/** The judgement fields as a list, then the text to post. */
function judgementBlocks(item: JudgementItem, ctx: RenderContext, full: boolean): BlockInput {
    const own = item.kind === "D" || item.kind === "Y";
    const rows: string[] = [];
    const add = (label: string, key: string): void => {
        const value = item.fields.get(key)?.trim();

        if (value) {
            rows.push(`**${label}:** ${linkify(value, ctx.repoPath)}`);
        }
    };

    add("Severity", "Severity");
    add(own ? "Verdict on the comment" : "Verdict", own ? "Verdict on the comment" : "Verdict");
    add("Answer to the comment", "Answer to the comment");
    add("Proposal", "Proposal");
    add("💡 Suggestion", "💡 Suggestion");

    const rationale = item.bullets.get("Rationale")?.filter((bullet) => bullet.trim()) ?? [];
    const action = (item.fields.get("Action") ?? "").trim();
    const move = item.fields.get("Move to")?.trim();
    const text = postedText(item, ctx.agent);
    const rewording = action === "move" || action === "reword" ? item.fences.get("Proposed rewording")?.trim() : null;
    const answer = own && action !== "reply" ? item.fences.get("Proposed answer")?.trim() : null;

    return [
        { ul: rows },
        full && rationale.length > 0
            ? [{ p: "**Rationale:**" }, { ul: rationale.map((bullet) => linkify(bullet, ctx.repoPath)) }]
            : [],
        {
            p: `**Action:** ${VERB[action] ?? action}${move && action === "move" ? ` to ${linkify(move, ctx.repoPath)}` : ""}`,
        },
        text ? { raw: copyBlock(text) } : [],
        rewording && !text ? { raw: copyBlock(rewording) } : [],
        answer
            ? [
                  { p: "**Answer, after the review is published:**" },
                  { raw: copyBlock(signedAnswer(item, answer, ctx.agent)) },
              ]
            : [],
    ];
}

function knownOf(ctx: RenderContext, item: JudgementItem): KnownItem | undefined {
    return ctx.known.find((known) => known.id === item.id);
}

function threadOf(ctx: RenderContext, item: JudgementItem): Discussion | undefined {
    const known = knownOf(ctx, item);

    return known?.pair.kind === "discussion" ? ctx.threads.get(known.pair.value) : undefined;
}

function draftOf(ctx: RenderContext, item: JudgementItem): DraftSummary | undefined {
    const known = knownOf(ctx, item);

    return known?.pair.kind === "draft" ? ctx.drafts.find((draft) => String(draft.id) === known.pair.value) : undefined;
}

function where(ctx: RenderContext, path: string | null, line: number | null): string {
    if (!path) {
        return "top-level";
    }

    return fileLink(join(ctx.repoPath, path), line);
}

function excerptBlock(
    ctx: RenderContext,
    target: { path: string | null; line: number | null; side: "new" | "old" }
): BlockInput {
    if (!ctx.files || !target.path || !target.line) {
        return [];
    }

    const excerpt = draftExcerpt(
        ctx.files,
        { id: 0, discussionId: null, path: target.path, line: target.line, side: target.side, note: "" },
        ctx.contextLines ?? 10
    );

    return excerpt.lines.length > 0
        ? [
              { p: `Code at the anchor (${excerpt.placement}; old · new · kind):` },
              { code: { content: excerpt.lines.join("\n"), language: fenceLanguage(target.path) } },
          ]
        : { p: `_Line ${target.line} is ${excerpt.placement}._` };
}

function heading(full: boolean, text: string): BlockInput {
    return full ? { h2: text } : { h3: text };
}

/** A thread (T or Y): its section from the thread renderer with the judgement inside it. */
function threadItemBlocks(item: JudgementItem, ctx: RenderContext, full: boolean): BlockInput {
    const thread = threadOf(ctx, item);
    const known = knownOf(ctx, item);

    if (full && thread && ctx.threadOpts) {
        return threadSectionsOf([thread], {
            ...ctx.threadOpts,
            afterNotes: () => [{ h3: "Judgement" }, judgementBlocks(item, ctx, true)],
        });
    }

    const label = thread && ctx.threadOpts ? threadDivergence(thread, ctx.threadOpts)?.text : null;
    const notes = (thread?.notes ?? []).filter((note) => String(note.body ?? "").trim());

    return [
        { h3: `${item.id} · ${where(ctx, known?.path ?? null, known?.line ?? null)}${label ? ` · ${label}` : ""}` },
        notes.length > 0
            ? notes.map((note) => ({ raw: `**@${note.author?.username ?? "?"}**:\n${quote(String(note.body))}` }))
            : known
              ? { raw: `**@${known.author}**:\n${quote(known.body)}` }
              : [],
        judgementBlocks(item, ctx, full),
    ];
}

/** One of my pending drafts: what it says in full, its code, then the judgement. */
function draftItemBlocks(item: JudgementItem, ctx: RenderContext, full: boolean): BlockInput {
    const draft = draftOf(ctx, item);
    const known = knownOf(ctx, item);
    const path = draft?.path ?? known?.path ?? null;
    const line = draft?.line ?? known?.line ?? null;

    return [
        heading(full, `${item.id} · draft ${known?.pair.value ?? "?"} · ${where(ctx, path, line)}`),
        { raw: `**Your draft:**\n${quote(draft?.note ?? known?.body ?? "")}` },
        full ? excerptBlock(ctx, { path, line, side: draft?.side === "old" ? "old" : "new" }) : [],
        full ? { h3: "Judgement" } : [],
        judgementBlocks(item, ctx, full),
        full ? { hr: true } : [],
    ];
}

function isUrgent(item: JudgementItem): boolean {
    const severity = item.fields.get("Severity") ?? "";

    return severity.includes("🛑") || severity.includes("⚠️") || /blocker|should fix/i.test(severity);
}

/** A new finding: its anchor and code, then the judgement. */
function findingBlocks(item: JudgementItem, ctx: RenderContext, full: boolean): BlockInput {
    const anchor = parseAnchor(item.fields.get("Anchor") ?? "");
    const target = typeof anchor === "string" || anchor.top ? null : anchor;
    const showCode = full || isUrgent(item);

    return [
        heading(
            full,
            `${item.id} · ${item.title}${target ? ` · ${where(ctx, target.path, target.line)}` : " · top-level"}`
        ),
        target?.text ? { p: `Anchor (${target.side} side): \`${target.text}\`` } : [],
        showCode && target ? excerptBlock(ctx, target) : [],
        full ? { h3: "Judgement" } : [],
        judgementBlocks(item, ctx, showCode),
        full ? { hr: true } : [],
    ];
}

function itemBlocks(item: JudgementItem, ctx: RenderContext, full: boolean): BlockInput {
    if (item.kind === "T" || item.kind === "Y") {
        return threadItemBlocks(item, ctx, full);
    }

    return item.kind === "D" ? draftItemBlocks(item, ctx, full) : findingBlocks(item, ctx, full);
}

// ─── documents ─────────────────────────────────────────────────────────────────

function headerBlocks(judgements: Judgements, ctx: RenderContext, title: string): BlockInput {
    const overall = judgements.header.get("Overall")?.trim();

    return [
        { h1: `${title}: !${ctx.iid} ${ctx.mr.title}` },
        {
            ul: [
                `${ctx.mode === "give" ? "Review given" : "Review received"} · \`${ctx.mr.sourceBranch}\` → \`${ctx.mr.targetBranch}\` · head \`${ctx.mr.headSha.slice(0, 10)}\``,
                `MR: ${ctx.mr.webUrl}`,
                ...(overall ? [`**Overall:** ${overall}`] : []),
            ],
        },
    ];
}

function sectionBlocks(judgements: Judgements, ctx: RenderContext): BlockInput {
    return [...judgements.sections]
        .filter(([, body]) => body.replace(/^-\s*$/gm, "").trim() !== "")
        .map(([name, body]) => [{ h2: name }, { raw: linkify(body, ctx.repoPath) }]);
}

function ordered(judgements: Judgements): JudgementItem[] {
    const rank = { T: 0, D: 1, Y: 2, N: 3 } as const;

    return judgements.items.filter(isJudged).sort((a, b) => rank[a.kind] - rank[b.kind] || a.id.localeCompare(b.id));
}

export function renderFull(judgements: Judgements, ctx: RenderContext): string {
    const items = ordered(judgements);
    const own = items.filter((item) => item.kind === "D" || item.kind === "Y");
    const findings = items.filter((item) => item.kind === "N");
    const threads = items.filter((item) => item.kind === "T");

    return json2md([
        headerBlocks(judgements, ctx, "Review"),
        threads.length > 0 ? [{ h2: "Threads" }, threads.map((item) => itemBlocks(item, ctx, true))] : [],
        own.length > 0 ? [{ h2: "Part A · your comments" }, own.map((item) => itemBlocks(item, ctx, true))] : [],
        findings.length > 0
            ? [
                  { h2: ctx.mode === "give" && own.length > 0 ? "Part B · new findings" : "New findings" },
                  findings.map((item) => itemBlocks(item, ctx, true)),
              ]
            : [],
        sectionBlocks(judgements, ctx),
    ]);
}

export function renderDigest(judgements: Judgements, ctx: RenderContext): string {
    const items = ordered(judgements);
    const skipped = judgements.items.filter((item) => !isJudged(item)).map((item) => item.id);

    return json2md([
        headerBlocks(judgements, ctx, "Digest"),
        items.map((item) => [itemBlocks(item, ctx, false), { hr: true }]),
        skipped.length > 0 ? { p: `Not judged: ${skipped.join(", ")}.` } : [],
        judgements.sections.get("Decisions")?.trim()
            ? [{ h2: "Decisions" }, { raw: linkify(judgements.sections.get("Decisions") ?? "", ctx.repoPath) }]
            : [],
    ]);
}

export function renderItems(judgements: Judgements, ctx: RenderContext, ids: string[]): string {
    const wanted = new Set(ids.map((id) => id.trim().toUpperCase()).filter(Boolean));
    const found = judgements.items.filter((item) => wanted.has(item.id));
    const missing = [...wanted].filter((id) => !found.some((item) => item.id === id));

    return json2md([
        found.map((item) => itemBlocks(item, ctx, true)),
        missing.length > 0 ? { p: `_No block in the judgements file for: ${missing.join(", ")}._` } : [],
    ]);
}

// ─── proposal ──────────────────────────────────────────────────────────────────

const SEVERITY: Array<[RegExp, string]> = [
    [/🛑|blocker/i, "blocker"],
    [/⚠️|should fix/i, "major"],
    [/❓|question/i, "question"],
    [/nit/i, "nit"],
];

const THREAD_VERDICT: Array<[RegExp, string]> = [
    [/invalid|not a bug|wrong/i, "invalid"],
    [/fixed/i, "already-fixed"],
    [/scope/i, "out-of-scope"],
    [/discuss|question|unclear/i, "needs-discussion"],
    [/valid|correct|right/i, "valid"],
];

function pick(table: Array<[RegExp, string]>, value: string): string | undefined {
    return table.find(([pattern]) => pattern.test(value))?.[1];
}

function decisionOf(overall: string): "approve" | "request_changes" | "comment" {
    if (/changes requested|request changes|blocked/i.test(overall)) {
        return "request_changes";
    }

    return /^approve\b(?! with)/i.test(overall.trim()) ? "approve" : "comment";
}

/** The review proposal for the GenesisTools review window: new findings as drafts, threads with verdicts. */
export function proposalFromJudgements(judgements: Judgements, ctx: RenderContext): Record<string, unknown> {
    const items = ordered(judgements);
    const overall = judgements.header.get("Overall")?.trim() ?? "";
    const reasoning = (item: JudgementItem): string | undefined =>
        item.bullets.get("Rationale")?.filter(Boolean).join("\n") || undefined;
    const drafts = items.flatMap((item) => {
        const anchor = parseAnchor(item.fields.get("Anchor") ?? "");
        const text = postedText(item, ctx.agent);

        if (item.kind !== "N" || typeof anchor === "string" || anchor.top || !text) {
            return [];
        }

        return [
            {
                id: item.id,
                path: anchor.path,
                side: anchor.side === "old" ? "deletions" : "additions",
                line: anchor.line,
                severity: pick(SEVERITY, item.fields.get("Severity") ?? "") ?? "minor",
                body: text,
                meta: {
                    verdict: verdictOf(item),
                    confidence: badgeOf(verdictOf(item)) ?? undefined,
                    reasoning: reasoning(item),
                },
            },
        ];
    });
    // Every thread with its real state, as the review-proposal skill asks; a judged one adds its verdict.
    const judgedThreads = new Map<string, JudgementItem>();

    for (const item of items) {
        const known = knownOf(ctx, item);

        if (known?.pair.kind === "discussion" && isJudged(item)) {
            judgedThreads.set(known.pair.value, item);
        }
    }

    const threads = ctx.discussions.map((d) => {
        const item = judgedThreads.get(d.id);

        return {
            threadId: d.id,
            ...(d.path ? { path: d.path } : {}),
            ...(d.line && d.line > 0 ? { line: d.line } : {}),
            author: d.author,
            ...(d.body.trim() ? { body: d.body } : {}),
            noteCount: d.noteCount,
            resolved: d.resolved,
            ...(item
                ? {
                      verdict: pick(THREAD_VERDICT, verdictOf(item)),
                      confidence: badgeOf(verdictOf(item)) ?? undefined,
                      reasoning: reasoning(item),
                      suggestedReply: postedText(item, ctx.agent) ?? undefined,
                  }
                : {}),
        };
    });
    const topLevel = items.filter(
        (item) => item.kind === "N" && !drafts.some((draft) => draft.id === item.id) && postedText(item, ctx.agent)
    );

    return {
        provider: "gitlab",
        host: hostnameOf(ctx.mr.host),
        project: ctx.mr.project,
        number: ctx.iid,
        url: ctx.mr.webUrl,
        title: ctx.mr.title,
        sourceBranch: ctx.mr.sourceBranch,
        targetBranch: ctx.mr.targetBranch,
        baseSha: ctx.mr.baseSha,
        headSha: ctx.mr.headSha,
        repoPath: ctx.repoPath,
        author: { agent: ctx.agent },
        verdict: {
            decision: decisionOf(overall),
            summary: overall || "No overall verdict in the judgements file.",
            confidence: badgeOf(overall) ?? undefined,
        },
        drafts,
        threads,
        ...(topLevel.length > 0
            ? { notes: topLevel.map((item) => `${item.id} (top-level): ${postedText(item, ctx.agent)}`).join("\n\n") }
            : {}),
    };
}
