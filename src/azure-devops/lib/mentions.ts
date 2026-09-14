import { normalizeUserName } from "@app/azure-devops/history";
import type { Comment } from "@app/azure-devops/types";
import { escapeWiqlValue } from "@app/azure-devops/wiql-builder";
import { logger } from "@genesiscz/utils/logger";
import { removeDiacritics } from "@genesiscz/utils/string";

/**
 * How many index candidates the second pass will read before it refuses. Pass two spends one HTTP
 * request per candidate, and `wiqlMentionTerm` searches a single word off the display name, so a
 * common given name over a wide window can return thousands.
 */
export const DEFAULT_MAX_CANDIDATES = 500;

/** One comment that names the user, inside the requested window. */
export interface MentionHit {
    workItemId: number;
    commentId: number;
    author: string;
    date: string;
    text: string;
}

/**
 * The result of the two-pass search. `candidateIds` is the raw WIQL answer and is reported next to
 * the confirmed hits on purpose: the history index also matches a field change made by that person
 * and older comments still in the item's history, so most candidates are not mentions. Dropping
 * them silently would hide how much of the answer the second pass threw away.
 */
export interface MentionSearchResult {
    candidateIds: number[];
    mentions: MentionHit[];
}

/**
 * The term to put in `[System.History] CONTAINS`. It comes off the RAW display name, not a
 * normalized one: the index holds the name as written, so stripping diacritics here would stop
 * `Nováková` matching. The parenthetical suffix some organisations append (`(QK)`) is dropped, and
 * the first word is selective enough while staying a single token the index can match.
 */
export function wiqlMentionTerm(userName: string): string {
    const withoutSuffix = userName.replace(/\s*\([^)]*\)\s*/g, " ").trim();
    const [firstWord] = withoutSuffix.split(/\s+/).filter(Boolean);

    return firstWord ?? userName.trim();
}

/**
 * The candidate query. `System.History CONTAINS` hits the history INDEX, so this is a filter and
 * never an answer: pass two has to confirm each item by reading its comments.
 */
export function buildMentionWiql({ term, from, to }: { term: string; from: string; to?: string }): string {
    // The project clause is not redundant with the project-scoped WIQL endpoint: every other
    // builder in `wiql-builder.ts` carries it, and without it the search reaches every project the
    // account can read. That is both surprising for a per-project tool and a direct multiplier on
    // the candidate count the second pass has to pay for, one HTTP request at a time.
    const clauses = [
        "[System.TeamProject] = @project",
        `[System.History] CONTAINS '${escapeWiqlValue(term)}'`,
        `[System.ChangedDate] >= '${escapeWiqlValue(from)}'`,
    ];

    if (to) {
        clauses.push(`[System.ChangedDate] <= '${escapeWiqlValue(to)}'`);
    }

    return [
        "SELECT [System.Id] FROM WorkItems",
        `WHERE ${clauses.join("\n  AND ")}`,
        "ORDER BY [System.ChangedDate] DESC",
    ].join("\n");
}

/**
 * A tag that ends a visual block. It becomes a SPACE, because the words either side of it are not
 * adjacent to a reader. The list has to cover table cells and headings, not just `p`/`div`/`li`:
 * an Azure DevOps comment may be rich text, and `<td>Nováková</td><td>Tereza</td>` stripped without
 * a space becomes `NovákováTereza`, which no longer contains the name at all.
 *
 * Attributes have to be allowed for. A closing tag carries none, so `<td class="x">A</td>` is
 * already handled by its `</td>`, but a VOID block tag has no closing half: `A<br class="x">B`
 * matched nothing here, fell through to the generic stripper and came back as `AB`. The same goes
 * for a self-closing `<br … />` and for an unclosed `<td …>`, which HTML5 permits.
 */
const BLOCK_TAG =
    /<\/?(?:br|p|div|li|ul|ol|table|thead|tbody|tr|td|th|h[1-6]|blockquote|pre|section|article)(?:\s[^>]*)?\/?>/gi;

/** Comment bodies are HTML. The plain text is what a person reads and what the name match runs on. */
export function stripCommentHtml(html: string): string {
    // Inline tags vanish WITHOUT a space on purpose: a name split mid-word by `<b>` must stay one
    // word, which is the opposite of what a block boundary needs.
    return html
        .replace(BLOCK_TAG, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Comment text is normalized as TEXT: lowercased, de-accented, whitespace collapsed. It must NOT go
 * through `normalizeUserName`, which also deletes anything in brackets. That is right for a display
 * name (`Surname Firstname (QK)`) and wrong for prose: a mention written inside a parenthesis, as in
 * `(@Surname Firstname (QK) add anything you have)`, was deleted whole and the real mention was
 * missed. One live work item was lost to exactly that.
 */
function normalizeCommentText(text: string): string {
    return removeDiacritics(text.toLowerCase()).replace(/\s+/g, " ").trim();
}

/**
 * Whether a comment names the user. An Azure DevOps mention renders as the full display name behind
 * an anchor (`@Surname Firstname (XX)`), so a contains match on the normalized name catches it, and
 * the adjacency branch below catches a comment that writes the same words the other way round.
 */
export function commentNamesUser(text: string, userName: string): boolean {
    const needle = normalizeUserName(userName);

    if (!needle) {
        return false;
    }

    const haystack = normalizeCommentText(stripCommentHtml(text));

    if (haystack.includes(needle)) {
        return true;
    }

    const words = needle.split(/\s+/).filter(Boolean);

    if (words.length < 2) {
        return false;
    }

    // The case this branch exists for writes the SAME words NEXT to each other, just the other way
    // round ("Tereza Nováková" for "Nováková Tereza"). Accepting each word anywhere in the comment
    // instead matched several different colleagues who between them happened to carry one word
    // each, and a mention search whose whole point is removing false positives cannot afford that.
    // Reversing the whole token list is exactly the surname-first to surname-last convention, so it
    // covers a three-part name for the same reason it covers a two-part one.
    const escaped = words.map(escapeRegExp);
    const forward = escaped.join("\\W+");
    const reversed = [...escaped].reverse().join("\\W+");

    return new RegExp(`\\b${forward}\\b`).test(haystack) || new RegExp(`\\b${reversed}\\b`).test(haystack);
}

function withinWindow(date: string, from: Date, to?: Date): boolean {
    const at = new Date(date);

    if (Number.isNaN(at.getTime())) {
        return false;
    }

    if (at < from) {
        return false;
    }

    return !(to && at > to);
}

/** The comments of one work item that name the user and were written inside the window. */
export function mentionsInComments({
    workItemId,
    comments,
    userName,
    from,
    to,
}: {
    workItemId: number;
    comments: Comment[];
    userName: string;
    from: Date;
    to?: Date;
}): MentionHit[] {
    const hits: MentionHit[] = [];

    for (const comment of comments) {
        if (!withinWindow(comment.date, from, to)) {
            continue;
        }

        if (!commentNamesUser(comment.text, userName)) {
            continue;
        }

        hits.push({
            workItemId,
            commentId: comment.id,
            author: comment.author,
            date: comment.date,
            text: stripCommentHtml(comment.text),
        });
    }

    return hits;
}

/** Raised instead of reading a candidate list whose second pass would cost more than the ceiling. */
export class TooManyCandidatesError extends Error {
    constructor(
        readonly candidateCount: number,
        readonly maxCandidates: number
    ) {
        super(
            `The history index returned ${candidateCount} candidates and the second pass reads each one's ` +
                `comments over its own HTTP request, so this would cost ${candidateCount} requests. ` +
                `Narrow the window with --from / --to, or raise the ceiling with --max-candidates ${candidateCount}.`
        );
        this.name = "TooManyCandidatesError";
    }
}

/**
 * The two-pass search. Pass one asks the history index for candidates; pass two reads each
 * candidate's comments and keeps only those written in the window that name the user. One pass
 * alone is mostly false positives, which is why both counts come back.
 */
export async function findMentions({
    userName,
    from,
    to,
    maxCandidates = DEFAULT_MAX_CANDIDATES,
    runWiql,
    fetchComments,
}: {
    userName: string;
    from: Date;
    to?: Date;
    maxCandidates?: number;
    runWiql: (wiql: string) => Promise<number[]>;
    fetchComments: (ids: number[]) => Promise<Map<number, Comment[]>>;
}): Promise<MentionSearchResult> {
    const term = wiqlMentionTerm(userName);
    // The bounds carry their time. A bare `YYYY-MM-DD` means midnight to WIQL (see
    // docs/wiql-syntax.md), so `<= '<to>'` dropped every comment written ON the --to day, while
    // the caller had already set that Date to 23:59:59 and the pass-two filter honoured it. The
    // two bounds disagreed by a whole day and the narrower one silently won.
    const wiql = buildMentionWiql({
        term,
        from: from.toISOString(),
        to: to?.toISOString(),
    });

    logger.debug(`[mentions] candidate query for '${term}':\n${wiql}`);
    const candidateIds = await runWiql(wiql);
    logger.debug(`[mentions] ${candidateIds.length} candidate work item(s) from the history index`);

    if (candidateIds.length === 0) {
        return { candidateIds, mentions: [] };
    }

    // Refusing beats truncating. Keeping the first N candidates would drop real mentions and still
    // print a confident total, which is the failure mode this whole two-pass search exists to end.
    if (candidateIds.length > maxCandidates) {
        throw new TooManyCandidatesError(candidateIds.length, maxCandidates);
    }

    const commentsById = await fetchComments(candidateIds);
    const mentions: MentionHit[] = [];

    for (const workItemId of candidateIds) {
        const comments = commentsById.get(workItemId) ?? [];
        mentions.push(...mentionsInComments({ workItemId, comments, userName, from, to }));
    }

    mentions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    logger.debug(`[mentions] ${mentions.length} confirmed mention(s) across ${candidateIds.length} candidates`);

    return { candidateIds, mentions };
}
