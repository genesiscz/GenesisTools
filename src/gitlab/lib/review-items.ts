/**
 * What a review can judge on one MR right now, with the ids of its stored map: threads others started
 * (`T`), threads I started (`Y`) and my pending drafts (`D`). `review skeleton`, `review check`,
 * `review render` and `comments post` all read the MR through this, so they agree on every id.
 */

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentUser, type ProjectApi } from "@app/gitlab/lib/client";
import { assignIds, assignThreadRefs, idMapPath, keyOfId, loadIdMap, parseId, saveIdMap } from "@app/gitlab/lib/ids";
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

/**
 * `persist` saves ids given to new items. Only a command that hands ids out (`review skeleton`) or acts on
 * them (`comments post --apply`) saves; `check`, `render` and a dry run read the map and leave it as it was.
 * The ids they compute are the same: assignment is deterministic for the same map and the same MR.
 */
export async function reviewItems(
    api: ProjectApi,
    iid: number,
    options: { mode: "receive" | "give"; persist: boolean }
): Promise<ReviewItems> {
    const { mode } = options;
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
    if (options.persist) {
        saveIdMap(path, map);
    }

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
    // A D id whose draft was published now names a thread; its block can still answer into it.
    const publishedItems: KnownItem[] = Object.entries(map.published ?? {}).flatMap(([id, entry]) => {
        const thread = discussions.find((d) => d.id === entry.discussionId);

        return drafts.some((draft) => draft.id === entry.draftId) || !thread
            ? []
            : [
                  {
                      ...threadItem(thread),
                      id,
                      kind: "D" as const,
                      publishedFrom: String(entry.draftId),
                  },
              ];
    });
    const publishedThreads = new Set(publishedItems.map((item) => item.pair.value));
    const known =
        mode === "receive"
            ? discussions.filter((d) => !d.resolved && d.path !== null && d.author !== me.username).map(threadItem)
            : [
                  ...draftItems,
                  ...publishedItems,
                  ...discussions.filter((d) => d.author === me.username && !publishedThreads.has(d.id)).map(threadItem),
              ];

    return {
        me: me.username,
        author: mr.author.username,
        headSha: mr.sha,
        discussions: discussions.map((d) => ({ ...d, ref: threadRefs.get(d.id) })),
        drafts: drafts.map((draft, i) => ({ ...draft, ref: draftRefs[i] })),
        known,
    };
}

/** Draft ids for `--expect`, which takes D ids (`D02`) as well as GitLab draft ids (`22970`). */
export function expectedDraftIds(
    api: ProjectApi,
    iid: number,
    tokens: string[]
): { ids: Set<string>; unknown: string[] } {
    const map = loadIdMap(idMapPath({ host: api.host, project: api.project, iid }));
    const ids = new Set<string>();
    const unknown: string[] = [];

    for (const token of tokens.map((t) => t.trim()).filter(Boolean)) {
        if (/^\d+$/.test(token)) {
            ids.add(token);
            continue;
        }

        const key = parseId(token)?.kind === "D" ? keyOfId(map, token) : null;

        if (key) {
            ids.add(key.key);
        } else {
            unknown.push(token);
        }
    }

    return { ids, unknown };
}

const flatText = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * After a publish: which thread each published draft became, kept in the MR's id map so its D id can
 * still answer into it (`comments post --answers D05`). Matched on author, anchor and text.
 */
export async function recordPublished(
    api: ProjectApi,
    iid: number,
    published: DraftSummary[]
): Promise<{ mapped: number; unmatched: string[] }> {
    const [me, discussions] = await Promise.all([currentUser(api), fetchDiscussions(api, String(iid))]);
    const path = idMapPath({ host: api.host, project: api.project, iid });
    const map = loadIdMap(path);
    const refs = assignIds(
        map,
        "D",
        published.map((draft) => String(draft.id))
    );
    const unmatched: string[] = [];
    const publishedMap = { ...map.published };
    map.published = publishedMap;

    published.forEach((draft, i) => {
        // A reply draft joins a thread anyone may have started; only a new thread is mine.
        const thread = discussions.find((d) =>
            draft.discussionId
                ? d.id === draft.discussionId
                : d.author === me.username &&
                  d.path === draft.path &&
                  d.line === draft.line &&
                  d.body === flatText(draft.note)
        );

        if (thread && !draft.discussionId) {
            publishedMap[refs[i]] = { discussionId: thread.id, draftId: draft.id };
        } else if (!thread) {
            unmatched.push(refs[i]);
        }
    });

    saveIdMap(path, map);

    return { mapped: published.length - unmatched.length, unmatched };
}
