/**
 * A merge request, scoped so a script never repeats the host, the project, the IID or the token.
 *
 *   import { mr } from "@app/gitlab/lib/mr";
 *
 *   const review = mr(42, { project: "acme/web-app" });
 *   for (const t of await review.discussions({ unresolved: true })) {
 *     await review.reply(t.id, "…");
 *   }
 *   await review.publishDrafts();
 *
 * Host, token and project resolve once, lazily, on the first call that needs them, the same way
 * the CLI resolves them.
 */

import { type ProjectApi, resolveProjectApi } from "@app/gitlab/lib/client";
import {
    type DiffRefs,
    type DiscussionSummary,
    type DraftSummary,
    type DraftWriteResult,
    deleteDraft,
    fetchDiffRefs,
    fetchDiscussions,
    fetchDrafts,
    findUnanchoredDrafts,
    postNote,
    postReplyNow,
    publishAllDrafts,
    resolveDiscussion,
    writeAnchoredDraft,
    writeDraftReply,
    writeTopLevelDraft,
} from "@app/gitlab/lib/review-drafts";

export interface MergeRequestTarget {
    host?: string;
    project?: string;
    /** Checkout whose `origin` names the project when `project` is not given. */
    cwd?: string;
}

export class MergeRequest {
    private resolved: Promise<ProjectApi> | null = null;

    constructor(
        readonly iid: string,
        private readonly target: MergeRequestTarget = {}
    ) {}

    private api(): Promise<ProjectApi> {
        this.resolved ??= resolveProjectApi(this.target);

        return this.resolved;
    }

    /** Threads, each reduced to its opening note. `author` is who a reply's second person addresses. */
    async discussions(filter: { author?: string; unresolved?: boolean } = {}): Promise<DiscussionSummary[]> {
        let all = await fetchDiscussions(await this.api(), this.iid);

        if (filter.author) {
            all = all.filter((d) => d.author === filter.author);
        }

        if (filter.unresolved) {
            all = all.filter((d) => !d.resolved);
        }

        return all;
    }

    async drafts(): Promise<DraftSummary[]> {
        return fetchDrafts(await this.api(), this.iid);
    }

    async diffRefs(): Promise<DiffRefs> {
        return fetchDiffRefs(await this.api(), this.iid);
    }

    /** Unpublished draft reply. Updates the thread's existing draft, since only one may be pending. */
    async reply(
        discussionId: string,
        body: string,
        options: { append?: boolean; knownDrafts?: DraftSummary[] } = {}
    ): Promise<DraftWriteResult> {
        return writeDraftReply(await this.api(), { iid: this.iid, discussionId, body, ...options });
    }

    /** Visible at once, no review batch. */
    async replyNow(discussionId: string, body: string): Promise<{ ok: boolean; noteId?: number; error?: string }> {
        return postReplyNow(await this.api(), { iid: this.iid, discussionId, body });
    }

    async resolve(discussionId: string, resolved = true): Promise<{ ok: boolean; error?: string }> {
        return resolveDiscussion(await this.api(), { iid: this.iid, discussionId, resolved });
    }

    /** Draft anchored to a line of the diff; the anchor is read back, so a dropped one fails loudly. */
    async draftOnLine(anchor: { path: string; line: number }, body: string): Promise<DraftWriteResult> {
        return writeAnchoredDraft(await this.api(), { iid: this.iid, ...anchor, body });
    }

    async draftNote(body: string): Promise<DraftWriteResult> {
        return writeTopLevelDraft(await this.api(), this.iid, body);
    }

    /** Published top-level comment. */
    async note(body: string): Promise<{ ok: boolean; noteId?: number; error?: string }> {
        return postNote(await this.api(), this.iid, body);
    }

    async deleteDraft(draftId: number): Promise<{ ok: boolean; error?: string }> {
        return deleteDraft(await this.api(), this.iid, draftId);
    }

    async publishDrafts(): Promise<{ ok: boolean; error?: string }> {
        return publishAllDrafts(await this.api(), this.iid);
    }

    /** Drafts that carry no thread, so a bad discussion id does not pass as an intentional note. */
    async unanchoredDrafts(intentionalTopLevel: number[] = []): Promise<DraftSummary[]> {
        return findUnanchoredDrafts(await this.drafts(), intentionalTopLevel);
    }

    /** Replies to many threads with one draft read, so each reply costs one request instead of two. Input order. */
    async replyMany(replies: Array<{ discussionId: string; body: string }>): Promise<DraftWriteResult[]> {
        const knownDrafts = await this.drafts();
        const results: DraftWriteResult[] = [];

        for (const { discussionId, body } of replies) {
            results.push(await this.reply(discussionId, body, { knownDrafts }));
        }

        return results;
    }
}

export function mr(iid: string | number, target: MergeRequestTarget = {}): MergeRequest {
    return new MergeRequest(String(iid), target);
}
