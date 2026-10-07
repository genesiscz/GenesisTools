/**
 * What a review can judge on one MR right now, with the ids of its stored map: threads others started
 * (`T`), threads I started (`Y`) and my pending drafts (`D`). `review skeleton`, `review check`,
 * `review render` and `comments post` all read the MR through this, so they agree on every id.
 */

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentUser, type ProjectApi } from "@app/gitlab/lib/client";
import { assignIds, assignThreadRefs, idMapPath, loadIdMap, saveIdMap } from "@app/gitlab/lib/ids";
import type { KnownItem } from "@app/gitlab/lib/judgements-check";
import { fetchMr } from "@app/gitlab/lib/merge-requests";
import {
    type DiscussionSummary,
    type DraftSummary,
    fetchDiscussions,
    fetchDrafts,
} from "@app/gitlab/lib/review-drafts";

export interface ReviewItems {
    me: string;
    author: string;
    headSha: string;
    discussions: DiscussionSummary[];
    drafts: DraftSummary[];
    /** Receive: unresolved diff threads others started. Give: my drafts and my threads. */
    known: KnownItem[];
}

/** The default judgements file of an MR, beside the other review files in the temp folder. */
export function judgementsPath(mr: { host: string; project: string; iid: number }): string {
    const key = createHash("sha1").update(`${mr.host} ${mr.project}`).digest("hex").slice(0, 12);

    return join(tmpdir(), `gitlab-review-${key}-${mr.iid}-judgements.md`);
}

export async function reviewItems(api: ProjectApi, iid: number, mode: "receive" | "give"): Promise<ReviewItems> {
    const [mr, me, discussions, drafts] = await Promise.all([
        fetchMr(api, iid),
        currentUser(api),
        fetchDiscussions(api, String(iid)),
        fetchDrafts(api, String(iid)),
    ]);
    const path = idMapPath({ host: api.host, project: api.project, iid });
    const map = loadIdMap(path);
    const threadRefs = assignThreadRefs(map, discussions, me.username);
    const draftRefs = assignIds(
        map,
        "D",
        drafts.map((draft) => String(draft.id))
    );
    saveIdMap(path, map);

    const threadItem = (d: DiscussionSummary): KnownItem => ({
        id: threadRefs.get(d.id) ?? "",
        kind: d.author === me.username ? "Y" : "T",
        pair: { kind: "discussion", value: d.id },
        path: d.path,
        line: d.line,
        body: d.body,
        author: d.author,
    });
    const draftItems: KnownItem[] = drafts.map((draft, i) => ({
        id: draftRefs[i],
        kind: "D",
        pair: { kind: "draft", value: String(draft.id) },
        path: draft.path,
        line: draft.line,
        body: draft.note,
        author: me.username,
    }));
    const known =
        mode === "receive"
            ? discussions.filter((d) => !d.resolved && d.path !== null && d.author !== me.username).map(threadItem)
            : [...draftItems, ...discussions.filter((d) => d.author === me.username).map(threadItem)];

    return {
        me: me.username,
        author: mr.author.username,
        headSha: mr.sha,
        discussions: discussions.map((d) => ({ ...d, ref: threadRefs.get(d.id) })),
        drafts: drafts.map((draft, i) => ({ ...draft, ref: draftRefs[i] })),
        known,
    };
}
