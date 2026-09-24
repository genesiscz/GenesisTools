/**
 * Two-phase cleanup of stale MRs.
 *
 * Phase 1 (`post` + `apply-labels`): tell the author what looks stale, add the stale label,
 * record `postedAt` / `labelsAppliedAt`. Nothing is closed.
 * Phase 2, about a week later (`followup` + `close`): list the notified MRs, show what moved
 * since the notification, and close ONE MR at a time, each after an explicit approval.
 */

import { type ProjectApi, projectBase, restGet, restGetPaginated, restWrite } from "@app/gitlab/lib/client";
import { formatDate } from "@app/gitlab/lib/dates";
import { errorMessage, HttpError } from "@app/gitlab/lib/http";
import type { MrNote, MrWithNotes } from "@app/gitlab/lib/merge-requests";
import type { StaleMr } from "@app/gitlab/lib/stale-branches";
import type { AdoWorkItem } from "@app/gitlab/lib/work-items";

/** When the author was told: the later of the posted comment and the applied label. */
export function notifiedAt(mr: StaleMr): string | null {
    const stamps = [mr.review.postedAt, mr.review.labelsAppliedAt].filter((s): s is string => Boolean(s));

    return stamps.length ? (stamps.sort().at(-1) ?? null) : null;
}

export interface FollowupRow {
    iid: number;
    title: string;
    webUrl: string;
    recommendation: string;
    notifiedAt: string;
    daysSince: number;
    /** What happened after the notification; empty means silence. */
    activity: string[];
    liveState: string;
    /** Notified long enough ago, still open, and silent: safe to close after approval. */
    candidate: boolean;
}

export interface FollowupOptions {
    /** Days of silence required before an MR becomes a close candidate. */
    afterDays: number;
    /** Usernames whose notes do not count as activity (the person who posted the notification). */
    ignoreAuthors: string[];
    now?: Date;
}

/** Activity on the MR and its work item after `since`, ignoring the notifier's own notes. */
export function activitySince(options: {
    mr: StaleMr;
    live: MrWithNotes;
    liveAdo: AdoWorkItem | null;
    since: string;
    ignoreAuthors: string[];
}): string[] {
    const { mr, live, liveAdo, since } = options;
    const activity: string[] = [];
    const notes = live.notes.filter(
        (n) => !n.system && n.createdAt > since && !options.ignoreAuthors.includes(n.author)
    );
    const newest = [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (newest) {
        activity.push(
            `${notes.length} note(s), newest ${formatDate(newest.createdAt)} by ${newest.author}: ${newest.body.replace(/\s+/g, " ").slice(0, 120)}`
        );
    }

    if (live.sha !== mr.sha) {
        activity.push(`new commits (${mr.sha.slice(0, 8)} -> ${live.sha.slice(0, 8)})`);
    }

    if (live.state !== "opened") {
        activity.push(`MR is ${live.state}`);
    }

    if (live.draft !== mr.draft) {
        activity.push(live.draft ? "marked as draft" : "marked ready");
    }

    const storedAdo = mr.ado?.effective ?? mr.ado?.item ?? null;
    if (storedAdo && liveAdo && liveAdo.changed > since) {
        activity.push(
            `ADO ${liveAdo.id} changed ${formatDate(liveAdo.changed)} by ${liveAdo.changedBy ?? "unknown"} (state ${liveAdo.state})`
        );
    }

    return activity;
}

export function followupRow(
    mr: StaleMr,
    live: { mr: MrWithNotes; ado: AdoWorkItem | null },
    options: FollowupOptions
): FollowupRow {
    const since = notifiedAt(mr);
    if (!since) {
        throw new Error(`!${mr.iid} was never notified (no postedAt or labelsAppliedAt)`);
    }

    const now = options.now ?? new Date();
    const daysSince = Math.floor((now.getTime() - new Date(since).getTime()) / 86_400_000);
    const activity = activitySince({
        mr,
        live: live.mr,
        liveAdo: live.ado,
        since,
        ignoreAuthors: options.ignoreAuthors,
    });

    return {
        iid: mr.iid,
        title: mr.title,
        webUrl: mr.webUrl,
        recommendation: mr.review.recommendation ?? "?",
        notifiedAt: since,
        daysSince,
        activity,
        liveState: live.mr.state,
        candidate: live.mr.state === "opened" && daysSince >= options.afterDays && activity.length === 0,
    };
}

export function renderFollowupTable(rows: FollowupRow[]): string {
    const header =
        "| MR | Recommendation | Notified | Days | Activity since | Close candidate |\n|---|---|---|---:|---|---|";
    const body = rows.map(
        (r) =>
            `| [!${r.iid}](${r.webUrl}) | ${r.recommendation} | ${formatDate(r.notifiedAt)} | ${r.daysSince} | ${r.activity.length ? r.activity.join("; ").replaceAll("|", "\\|") : "none"} | ${r.candidate ? "yes" : r.liveState !== "opened" ? r.liveState : "no"} |`
    );

    return [header, ...body].join("\n");
}

/**
 * The published copy of a draft note, when it was published in the GitLab UI instead of through
 * `publish`: the newest non-system note that starts with the text this flow sent.
 *
 * `sentBody`, not `draftComment`: `post --draft` folds pending side texts in after the comment,
 * so the published note is longer than `draftComment` and an equality test never matched it.
 * A prefix, not equality: after `sync-note`, `sentBody` holds the comment alone while the live
 * note still carries the side text appended to it.
 */
export function findPublishedDraft(mr: StaleMr, live: MrWithNotes): MrNote | null {
    const body = (mr.review.sentBody ?? mr.review.draftComment)?.trim();
    if (!mr.review.draftNoteId || !body) {
        return null;
    }

    return (
        live.notes
            .filter((n) => !n.system && n.body.trim().startsWith(body))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
    );
}

/** Reviewed MRs that were notified and not closed by this flow yet. */
export function notifiedMrs(mrs: StaleMr[], iid?: number): StaleMr[] {
    const result = mrs.filter(
        (mr) =>
            mr.needsReview && notifiedAt(mr) !== null && !mr.review.closedAt && (iid === undefined || mr.iid === iid)
    );
    if (iid !== undefined && !result.length) {
        throw new Error(`!${iid} was not notified by this flow, or is already closed by it`);
    }

    return result;
}

export async function closeMr(
    api: ProjectApi,
    iid: number
): Promise<{ ok: boolean; status: number; state: string | null; error?: string }> {
    try {
        const json = await restWrite<{ state?: string }>(api, {
            method: "PUT",
            path: `${projectBase(api)}/merge_requests/${iid}`,
            body: { state_event: "close" },
            retries: 1,
        });

        return {
            ok: json.state === "closed",
            status: 200,
            state: json.state ?? null,
            error: json.state === "closed" ? undefined : `state is ${json.state}`,
        };
    } catch (e: unknown) {
        if (e instanceof HttpError) {
            return { ok: false, status: e.status, state: null, error: (e.body ?? "").slice(0, 200) };
        }

        return { ok: false, status: 0, state: null, error: errorMessage(e) };
    }
}

export function markClosed(mr: StaleMr, now = new Date()): void {
    mr.review.closedAt = now.toISOString();
}

/** Other open MRs in the report that still use the branch as source or target; deleting it would break them. */
export function branchUsers(branch: string, mr: StaleMr, all: StaleMr[]): StaleMr[] {
    return all.filter(
        (other) =>
            other.iid !== mr.iid &&
            !other.review.closedAt &&
            (other.sourceBranch === branch || other.targetBranch === branch)
    );
}

/** Null when the branch does not exist on the remote. */
export async function branchProtected(api: ProjectApi, branch: string): Promise<boolean | null> {
    try {
        const info = await restGet<{ protected?: boolean }>(
            api,
            `${projectBase(api)}/repository/branches/${encodeURIComponent(branch)}`,
            { timeout: 15_000, retries: 1 }
        );

        return info.protected === true;
    } catch (e: unknown) {
        if (e instanceof HttpError && e.status === 404) {
            return null;
        }

        throw new Error(`Cannot read branch ${branch}: ${errorMessage(e)}`);
    }
}

/** Open MRs that use `branch` as source or target, read LIVE from GitLab rather than from the sweep JSON. */
export async function liveBranchUsers(api: ProjectApi, branch: string): Promise<number[]> {
    const base = `${projectBase(api)}/merge_requests?state=opened`;
    const [asSource, asTarget] = await Promise.all([
        restGetPaginated<{ iid: number }>(api, `${base}&source_branch=${encodeURIComponent(branch)}`),
        restGetPaginated<{ iid: number }>(api, `${base}&target_branch=${encodeURIComponent(branch)}`),
    ]);

    return [...new Set([...asSource, ...asTarget].map((mr) => mr.iid))];
}

/** The three live reads and the one irreversible call behind `deleteUnusedBranch`; a test swaps them. */
export interface BranchDeleteOps {
    liveUsers(branch: string): Promise<number[]>;
    isProtected(branch: string): Promise<boolean | null>;
    remove(branch: string): Promise<{ ok: boolean; status: number; error?: string }>;
}

export type BranchDeleteResult =
    | { outcome: "deleted" }
    | { outcome: "missing" }
    | { outcome: "protected" }
    | { outcome: "in-use"; users: number[] }
    | { outcome: "failed"; status: number; error?: string };

export function branchDeleteOps(api: ProjectApi): BranchDeleteOps {
    return {
        liveUsers: (branch) => liveBranchUsers(api, branch),
        isProtected: (branch) => branchProtected(api, branch),
        remove: (branch) => deleteBranchRef(api, branch),
    };
}

/**
 * Delete a closed MR's branch only when the LIVE state still allows it, checked immediately before
 * the DELETE. The sweep JSON is hours old by the time `close` runs: a branch that a new MR started
 * to use since then was deleted from under it. `closedIid` is the MR this flow just closed.
 */
export async function deleteUnusedBranch({
    branch,
    closedIid,
    ops,
}: {
    branch: string;
    closedIid: number;
    ops: BranchDeleteOps;
}): Promise<BranchDeleteResult> {
    const users = (await ops.liveUsers(branch)).filter((iid) => iid !== closedIid);

    if (users.length > 0) {
        return { outcome: "in-use", users };
    }

    const isProtected = await ops.isProtected(branch);

    if (isProtected === null) {
        return { outcome: "missing" };
    }

    if (isProtected) {
        return { outcome: "protected" };
    }

    const removed = await ops.remove(branch);

    return removed.ok ? { outcome: "deleted" } : { outcome: "failed", status: removed.status, error: removed.error };
}

/** The raw DELETE. Not exported: every caller goes through `deleteUnusedBranch` and its live guard. */
async function deleteBranchRef(
    api: ProjectApi,
    branch: string
): Promise<{ ok: boolean; status: number; error?: string }> {
    try {
        await restWrite<void>(api, {
            method: "DELETE",
            path: `${projectBase(api)}/repository/branches/${encodeURIComponent(branch)}`,
            retries: 1,
        });

        return { ok: true, status: 204 };
    } catch (e: unknown) {
        if (e instanceof HttpError) {
            return { ok: false, status: e.status, error: (e.body ?? "").slice(0, 200) };
        }

        return { ok: false, status: 0, error: errorMessage(e) };
    }
}

export function markBranchDeleted(mr: StaleMr, now = new Date()): void {
    mr.review.sourceBranchDeletedAt = now.toISOString();
}
