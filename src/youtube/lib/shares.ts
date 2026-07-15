import { randomBytes } from "node:crypto";
import { SafeJSON } from "@app/utils/json";
import type { ShareRow, YoutubeDatabase } from "@app/youtube/lib/db";
import type { AskCitation } from "@app/youtube/lib/qa.types";
import type { ShareKind, ShareSummary } from "@app/youtube/lib/shares.types";
import type { YtUser } from "@app/youtube/lib/users.types";
import type { TimestampedSummaryEntry, VideoLongSummary } from "@app/youtube/lib/video.types";
import { Marked, type Tokens } from "marked";

export const SHARE_SLUG_LENGTH = 12;
const SHARE_RATE_LIMIT_PER_HOUR = 10;
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

interface SharePayloadBase {
    videoTitle: string;
    channel: string | null;
    thumbnailUrl: string | null;
}

interface SummarySharePayloadShort extends SharePayloadBase {
    kind: "summary";
    mode: "short";
    content: string;
}

interface SummarySharePayloadTimestamped extends SharePayloadBase {
    kind: "summary";
    mode: "timestamped";
    content: TimestampedSummaryEntry[];
}

interface SummarySharePayloadLong extends SharePayloadBase {
    kind: "summary";
    mode: "long";
    content: VideoLongSummary;
}

type SummarySharePayload = SummarySharePayloadShort | SummarySharePayloadTimestamped | SummarySharePayloadLong;

interface QaSharePayload extends SharePayloadBase {
    kind: "qa";
    question: string;
    answer: string;
    citations: AskCitation[];
}

type SharePayload = SummarySharePayload | QaSharePayload;

function generateSlug(): string {
    const bytes = randomBytes(SHARE_SLUG_LENGTH);
    let slug = "";

    for (let i = 0; i < SHARE_SLUG_LENGTH; i++) {
        slug += BASE62[bytes[i] % BASE62.length];
    }

    return slug;
}

/**
 * Snapshots the current content for a summary or Ask exchange into a public,
 * revocable share. Payload is a full snapshot at creation time — later
 * regenerations of the underlying summary/answer never mutate it.
 */
export async function createShare(opts: {
    db: YoutubeDatabase;
    user: YtUser;
    kind: ShareKind;
    videoId: string;
    baseUrl: string;
    mode?: "short" | "timestamped" | "long";
    qaHistoryId?: number;
}): Promise<{ slug: string; url: string }> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    if (opts.db.countSharesSince(opts.user.id, oneHourAgo) >= SHARE_RATE_LIMIT_PER_HOUR) {
        throw new Error("share rate limit reached");
    }

    const payload = buildSharePayload(opts);
    const slug = generateSlug();
    opts.db.createShareRow({
        slug,
        userId: opts.user.id,
        kind: opts.kind,
        videoId: opts.videoId,
        payloadJson: SafeJSON.stringify(payload, { strict: true }),
    });

    return { slug, url: `${opts.baseUrl.replace(/\/$/, "")}/share/${slug}` };
}

function buildSharePayload(opts: {
    db: YoutubeDatabase;
    user: YtUser;
    kind: ShareKind;
    videoId: string;
    mode?: "short" | "timestamped" | "long";
    qaHistoryId?: number;
}): SharePayload {
    const video = opts.db.getVideo(opts.videoId);

    if (!video) {
        throw new Error("video not found");
    }

    const base: SharePayloadBase = {
        videoTitle: video.title,
        channel: video.channelHandle,
        thumbnailUrl: video.thumbUrl,
    };

    if (opts.kind === "summary") {
        if (!opts.mode) {
            throw new Error("summary share requires {mode}");
        }

        if (opts.mode === "short") {
            if (!video.summaryShort) {
                throw new Error("no short summary generated for this video yet");
            }

            return { ...base, kind: "summary", mode: "short", content: video.summaryShort };
        }

        if (opts.mode === "timestamped") {
            if (!video.summaryTimestamped) {
                throw new Error("no timestamped summary generated for this video yet");
            }

            return { ...base, kind: "summary", mode: "timestamped", content: video.summaryTimestamped };
        }

        if (!video.summaryLong) {
            throw new Error("no long summary generated for this video yet");
        }

        return { ...base, kind: "summary", mode: "long", content: video.summaryLong };
    }

    if (!opts.qaHistoryId) {
        throw new Error("qa share requires {qaHistoryId}");
    }

    const qa = opts.db.getQaHistoryById(opts.user.id, opts.qaHistoryId);

    if (!qa || qa.videoId !== opts.videoId) {
        throw new Error("qa history entry not found");
    }

    return { ...base, kind: "qa", question: qa.question, answer: qa.answer, citations: qa.citations };
}

export function listShares(db: YoutubeDatabase, userId: number, baseUrl: string): ShareSummary[] {
    return db.listSharesForUser(userId).map((row) => rowToShareSummary(row, baseUrl));
}

function rowToShareSummary(row: ShareRow, baseUrl: string): ShareSummary {
    const payload = SafeJSON.parse(row.payload_json) as SharePayload;

    return {
        slug: row.slug,
        url: `${baseUrl.replace(/\/$/, "")}/share/${row.slug}`,
        kind: row.kind,
        videoId: row.video_id,
        videoTitle: payload.videoTitle,
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
    };
}

export function revokeShare(db: YoutubeDatabase, userId: number, slug: string): boolean {
    return db.revokeShareRow(userId, slug);
}

// Duplicated (not imported) from @app/utils/ui/components/markdown.tsx per the
// plan's Task 0 instruction: that component is a React client (imports
// `react`, ships JSX) — this lib renders a plain HTML string server-side and
// must stay dependency-free of the UI layer. Same hardening: raw HTML
// escaped, only http/https/mailto + relative/anchor hrefs survive.
const shareMarked = new Marked({ gfm: true, breaks: true });

function escapeHtml(html: string): string {
    return html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
    return escapeHtml(value).replace(/"/g, "&quot;");
}

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function isSafeHref(href: string): boolean {
    try {
        return SAFE_LINK_PROTOCOLS.has(new URL(href, "https://relative.invalid/").protocol);
    } catch {
        return false;
    }
}

shareMarked.use({
    renderer: {
        html({ text }: { text: string }) {
            return escapeHtml(text);
        },
        link(token: Tokens.Link) {
            const label = this.parser.parseInline(token.tokens);

            if (!isSafeHref(token.href)) {
                return label;
            }

            return `<a href="${escapeAttr(token.href)}" target="_blank" rel="noreferrer noopener">${label}</a>`;
        },
    },
});

function renderShareMarkdown(md: string): string {
    return shareMarked.parse(md, { async: false });
}

function watchUrl(videoId: string, startSec?: number | null): string {
    const base = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    return startSec !== null && startSec !== undefined ? `${base}&t=${Math.floor(startSec)}s` : base;
}

function formatTimecode(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

function ogDescriptionFor(payload: SharePayload): string {
    const raw =
        payload.kind === "qa"
            ? payload.answer
            : payload.mode === "long"
              ? payload.content.tldr
              : payload.mode === "short"
                ? payload.content
                : (payload.content[0]?.text ?? "");

    const plain = raw
        .replace(/[#*_`>]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return plain.length > 160 ? `${plain.slice(0, 157)}...` : plain;
}

function renderSummaryContent(videoId: string, payload: SummarySharePayload): string {
    if (payload.mode === "short") {
        return `<div class="prose">${renderShareMarkdown(payload.content)}</div>`;
    }

    if (payload.mode === "timestamped") {
        const entries = payload.content;
        return entries
            .map(
                (entry) => `
                <section class="entry">
                    <a class="timecode" href="${escapeAttr(watchUrl(videoId, entry.startSec))}" target="_blank" rel="noreferrer noopener">
                        ${entry.icon ? escapeHtml(entry.icon) : ""} ${formatTimecode(entry.startSec)}
                    </a>
                    ${entry.title ? `<h3>${escapeHtml(entry.title)}</h3>` : ""}
                    <div class="prose">${renderShareMarkdown(entry.text)}</div>
                </section>`
            )
            .join("\n");
    }

    const long = payload.content;
    const keyPoints = long.keyPoints.map((point) => `<li>${escapeHtml(point)}</li>`).join("");
    const learnings = long.learnings.map((point) => `<li>${escapeHtml(point)}</li>`).join("");
    const chapters = long.chapters
        .map(
            (chapter) =>
                `<section class="entry"><h3>${escapeHtml(chapter.title)}</h3><div class="prose">${renderShareMarkdown(chapter.summary)}</div></section>`
        )
        .join("\n");

    return `
        <p class="tldr">${escapeHtml(long.tldr)}</p>
        ${keyPoints ? `<p class="label">Key points</p><ul>${keyPoints}</ul>` : ""}
        ${learnings ? `<p class="label">Learnings</p><ul>${learnings}</ul>` : ""}
        ${chapters ? `<p class="label">Chapters</p>${chapters}` : ""}
        ${long.conclusion ? `<p class="prose">${escapeHtml(long.conclusion)}</p>` : ""}
    `;
}

function renderQaContent(videoId: string, payload: QaSharePayload): string {
    const citations = payload.citations
        .filter((citation) => citation.startSec !== null)
        .map(
            (citation) =>
                `<a class="timecode" href="${escapeAttr(watchUrl(videoId, citation.startSec))}" target="_blank" rel="noreferrer noopener">${formatTimecode(citation.startSec as number)}</a>`
        )
        .join(" ");

    return `
        <p class="label">Question</p>
        <p class="tldr">${escapeHtml(payload.question)}</p>
        <p class="label">Answer</p>
        <div class="prose">${renderShareMarkdown(payload.answer)}</div>
        ${citations ? `<p class="label">Cited moments</p><p>${citations}</p>` : ""}
    `;
}

const SHARE_PAGE_STYLE = `
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
        margin: 0;
        background: #0f0f0f;
        color: rgba(255,255,255,0.86);
        font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .column { max-width: 680px; margin: 0 auto; padding: 48px 20px; }
    h1, h2, h3 { letter-spacing: -0.01em; color: rgba(255,255,255,0.95); }
    h1 { font-size: 22px; margin: 16px 0 4px; }
    h3 { font-size: 16px; margin: 0 0 6px; }
    a { color: #3ea6ff; }
    img.thumb { width: 100%; border-radius: 12px; display: block; }
    .label {
        font: 500 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        text-transform: uppercase;
        letter-spacing: 0.18em;
        color: rgba(255,255,255,0.5);
        margin: 24px 0 8px;
    }
    .channel { color: rgba(255,255,255,0.5); font-size: 13px; margin: 0 0 20px; }
    .tldr { font-size: 16px; }
    .entry { margin: 16px 0; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.08); }
    .timecode { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
    .prose { word-wrap: break-word; }
    .prose p { margin: 0 0 12px; }
    footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.08); color: rgba(255,255,255,0.4); font-size: 12px; }
`;

/**
 * Renders a share row's snapshot as a self-contained, server-rendered HTML
 * page: OG meta, video header, content, zero JavaScript, zero user identity.
 */
export function renderSharePage(row: ShareRow): string {
    const payload = SafeJSON.parse(row.payload_json) as SharePayload;
    const description = ogDescriptionFor(payload);
    const content =
        payload.kind === "summary"
            ? renderSummaryContent(row.video_id, payload)
            : renderQaContent(row.video_id, payload);
    const heading = payload.kind === "summary" ? `${payload.videoTitle} — Summary` : `${payload.videoTitle} — Q&A`;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(payload.videoTitle)}</title>
<meta property="og:title" content="${escapeAttr(payload.videoTitle)}" />
<meta property="og:description" content="${escapeAttr(description)}" />
${payload.thumbnailUrl ? `<meta property="og:image" content="${escapeAttr(payload.thumbnailUrl)}" />` : ""}
<meta name="twitter:card" content="summary_large_image" />
<style>${SHARE_PAGE_STYLE}</style>
</head>
<body>
<div class="column">
    ${payload.thumbnailUrl ? `<img class="thumb" src="${escapeAttr(payload.thumbnailUrl)}" alt="" />` : ""}
    <h1>${escapeHtml(heading)}</h1>
    ${payload.channel ? `<p class="channel">${escapeHtml(payload.channel)}</p>` : ""}
    ${content}
    <footer>Generated with AI &middot; GenesisTools</footer>
</div>
</body>
</html>`;
}

export function renderShareNotFoundPage(): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Link gone</title>
<style>${SHARE_PAGE_STYLE}</style>
</head>
<body>
<div class="column">
    <h1>This link is gone.</h1>
    <p>It was revoked, or never existed.</p>
</div>
</body>
</html>`;
}
