/**
 * The manifest of the staleness sweep: one durable record per MR we wrote to.
 *
 * The sweep JSON is a working file, big and full of per-MR evidence. The manifest is the small
 * answer to the only question that matters after the sweep: what did we send, where, and what
 * has the author done about it since. It is rewritten on every `manifest` run, and a run
 * compares itself with the previous manifest, so "what changed since I last looked" never has
 * to be reconstructed by hand.
 *
 * A contacted MR is one that carries our review comment, our labels, or one of our keyed side
 * texts. That is wider than `notifiedMrs` in stale-phases.ts, which only serves the close phase
 * and therefore requires `needsReview`.
 */

import { formatDate } from "@app/gitlab/lib/dates";
import type { MrWithNotes } from "@app/gitlab/lib/merge-requests";
import type { StaleMr } from "@app/gitlab/lib/stale-branches";
import type { AdoWorkItem } from "@app/gitlab/lib/work-items";

export const MANIFEST_STATUSES = [
    "merged",
    "closed",
    "label-removed",
    "answered-label-kept",
    "answered-no-label",
    "silent",
] as const;

export type ManifestStatus = (typeof MANIFEST_STATUSES)[number];

export const STATUS_MEANING: Record<ManifestStatus, string> = {
    merged: "the MR was merged after we wrote",
    closed: "the MR was closed after we wrote",
    "label-removed": "still open, the stale label we applied is gone",
    "answered-label-kept": "still open, the author reacted, the stale label is still on: it probably should come off",
    "answered-no-label": "still open, the author reacted, we never labelled it",
    silent: "still open, nothing moved since we wrote",
};

/** Which of our texts sits on the MR, and where. */
export interface SentText {
    /** `review` for the sweep comment, else the side-comment key (`closedBug`, or any `side-comment --key`). */
    kind: string;
    url: string | null;
    postedAt: string | null;
    /** First line of the text, so the manifest reads without opening GitLab. */
    excerpt: string;
}

export interface LabelFacts {
    applied: string[];
    removed: string[];
    appliedAt: string | null;
    /** `never-applied` when we never put the stale label on this MR. */
    staleLabel: "present" | "removed" | "never-applied";
}

export interface Reaction {
    /** Notes by anyone but us after our last contact. */
    notes: number;
    newestNoteAt: string | null;
    newestNoteBy: string | null;
    newestNoteExcerpt: string | null;
    newCommits: boolean;
    shaAtContact: string;
    shaNow: string;
    draftChanged: boolean;
    adoChanged: string | null;
}

export interface ManifestEntry {
    iid: number;
    title: string;
    webUrl: string;
    author: string;
    sourceBranch: string;
    targetBranch: string;
    ado: { id: number; title: string; state: string; url: string } | null;
    /** Our side: what we sent and when the last of it went out. */
    sent: SentText[];
    contactedAt: string;
    labels: LabelFacts;
    /** Their side, as of `checkedAt`. */
    state: string;
    labelsNow: string[];
    reaction: Reaction;
    daysSinceContact: number;
    status: ManifestStatus;
    /** Set by `close`, so a manifest never re-lists what this flow closed itself. */
    closedByUs: string | null;
    checkedAt: string;
}

export interface StaleManifest {
    _instructions: string;
    /** The sweep JSON this manifest was built from. */
    source: string;
    generatedAt: string;
    previousRunAt: string | null;
    entries: ManifestEntry[];
}

const INSTRUCTIONS =
    "Manifest of the open-MR staleness sweep: one entry per MR we wrote to. " +
    "Rebuild with `tools gitlab stale-branches manifest <sweep.json> --out <this file>`; it refetches every MR and its work item live " +
    "and reports what changed since `previousRunAt`. `status` is the answer to 'what happened after we wrote': " +
    `${MANIFEST_STATUSES.map((s) => `${s} = ${STATUS_MEANING[s]}`).join("; ")}. ` +
    "Never edit by hand: the sweep JSON is the source of our side, GitLab is the source of theirs.";

function excerpt(body: string, max = 140): string {
    const flat = body.replace(/\s+/g, " ").trim();

    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Every text of ours that reached GitLab on this MR, review comment first. */
export function sentTexts(mr: StaleMr): SentText[] {
    const sent: SentText[] = [];
    if (mr.review.postedAt) {
        sent.push({
            kind: "review",
            url: mr.review.postedNoteUrl ?? null,
            postedAt: mr.review.postedAt,
            excerpt: excerpt(mr.review.draftComment ?? ""),
        });
    }

    for (const side of mr.sideComments ?? []) {
        if (side.postedAt) {
            sent.push({
                kind: side.key,
                url: side.postedNoteUrl ?? null,
                postedAt: side.postedAt,
                excerpt: excerpt(side.body),
            });
        }
    }

    return sent;
}

/** The last moment we wrote to or labelled this MR; null when we never did. */
export function contactedAt(mr: StaleMr): string | null {
    const stamps = [mr.review.postedAt, mr.review.labelsAppliedAt, ...sentTexts(mr).map((s) => s.postedAt)].filter(
        (s): s is string => Boolean(s)
    );

    return stamps.length ? (stamps.sort().at(-1) ?? null) : null;
}

/** Every MR the sweep wrote to: our comment, our labels, or one of our side texts. */
export function contactedMrs(mrs: StaleMr[], iid?: number): StaleMr[] {
    const result = mrs.filter((mr) => contactedAt(mr) !== null && (iid === undefined || mr.iid === iid));
    if (iid !== undefined && !result.length) {
        throw new Error(`!${iid} was never written to by this sweep`);
    }

    return result;
}

/**
 * Whether the sweep is the reason the MR carried the stale label after `apply-labels` ran.
 *
 * Not the same as "we added it": some MRs already had the label when the sweep reached them, so
 * `labelsAfter` minus `labelsBefore` is empty there while the label is still ours to follow. The
 * plan in `review.labels` is what says we own it.
 */
function weOwnStale(mr: StaleMr, staleLabel: string): boolean {
    if (!mr.review.labelsAppliedAt) {
        return false;
    }

    const planned = mr.review.labels.some((l) => l.type === "add" && l.label === staleLabel);

    return planned || (mr.review.labelsAfter ?? []).includes(staleLabel);
}

export function labelFacts(mr: StaleMr, live: MrWithNotes, staleLabel: string): LabelFacts {
    const before = mr.review.labelsBefore ?? [];
    const after = mr.review.labelsAfter ?? [];

    return {
        applied: after.filter((l) => !before.includes(l)),
        removed: before.filter((l) => !after.includes(l)),
        appliedAt: mr.review.labelsAppliedAt ?? null,
        staleLabel: !weOwnStale(mr, staleLabel)
            ? "never-applied"
            : live.labels.includes(staleLabel)
              ? "present"
              : "removed",
    };
}

export function reactionSince(options: {
    mr: StaleMr;
    live: MrWithNotes;
    liveAdo: AdoWorkItem | null;
    since: string;
    ignoreAuthors: string[];
}): Reaction {
    const { mr, live, liveAdo, since } = options;
    const notes = live.notes
        .filter((n) => !n.system && n.createdAt > since && !options.ignoreAuthors.includes(n.author))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const newest = notes[0] ?? null;
    const adoChanged =
        liveAdo && liveAdo.changed > since
            ? `${liveAdo.id} ${formatDate(liveAdo.changed)} by ${liveAdo.changedBy ?? "unknown"} (state ${liveAdo.state})`
            : null;

    return {
        notes: notes.length,
        newestNoteAt: newest?.createdAt ?? null,
        newestNoteBy: newest?.author ?? null,
        newestNoteExcerpt: newest ? excerpt(newest.body) : null,
        newCommits: live.sha !== mr.sha,
        shaAtContact: mr.sha,
        shaNow: live.sha,
        draftChanged: live.draft !== mr.draft,
        adoChanged,
    };
}

/** Any sign the author noticed: a reply, new commits, or a draft flip. A work-item edit alone does not count. */
export function reacted(reaction: Reaction): boolean {
    return reaction.notes > 0 || reaction.newCommits || reaction.draftChanged;
}

export function manifestStatus(state: string, labels: LabelFacts, reaction: Reaction): ManifestStatus {
    if (state === "merged") {
        return "merged";
    }

    if (state !== "opened") {
        return "closed";
    }

    if (labels.staleLabel === "removed") {
        return "label-removed";
    }

    if (!reacted(reaction)) {
        return "silent";
    }

    return labels.staleLabel === "present" ? "answered-label-kept" : "answered-no-label";
}

export interface ManifestOptions {
    ignoreAuthors: string[];
    staleLabel: string;
    now?: Date;
}

export function manifestEntry(
    mr: StaleMr,
    live: { mr: MrWithNotes; ado: AdoWorkItem | null },
    options: ManifestOptions
): ManifestEntry {
    const since = contactedAt(mr);
    if (!since) {
        throw new Error(`!${mr.iid} was never written to by this sweep`);
    }

    const now = options.now ?? new Date();
    const labels = labelFacts(mr, live.mr, options.staleLabel);
    const reaction = reactionSince({
        mr,
        live: live.mr,
        liveAdo: live.ado,
        since,
        ignoreAuthors: options.ignoreAuthors,
    });
    const ado = mr.ado?.effective ?? mr.ado?.item ?? null;

    return {
        iid: mr.iid,
        title: mr.title,
        webUrl: mr.webUrl,
        author: mr.author.username,
        sourceBranch: mr.sourceBranch,
        targetBranch: mr.targetBranch,
        ado: ado ? { id: ado.id, title: ado.title, state: live.ado?.state ?? ado.state, url: ado.url } : null,
        sent: sentTexts(mr),
        contactedAt: since,
        labels,
        state: live.mr.state,
        labelsNow: live.mr.labels,
        reaction,
        daysSinceContact: Math.floor((now.getTime() - new Date(since).getTime()) / 86_400_000),
        status: manifestStatus(live.mr.state, labels, reaction),
        closedByUs: mr.review.closedAt ?? null,
        checkedAt: now.toISOString(),
    };
}

export interface ManifestChange {
    iid: number;
    from: ManifestStatus;
    to: ManifestStatus;
}

/** Entries whose status differs from the previous manifest, plus the ones that are new to it. */
export function diffManifest(
    previous: StaleManifest | null,
    next: ManifestEntry[]
): { changed: ManifestChange[]; added: number[] } {
    if (!previous) {
        return { changed: [], added: next.map((e) => e.iid) };
    }

    const before = new Map(previous.entries.map((e) => [e.iid, e.status]));
    const changed: ManifestChange[] = [];
    const added: number[] = [];
    for (const entry of next) {
        const from = before.get(entry.iid);
        if (from === undefined) {
            added.push(entry.iid);
        } else if (from !== entry.status) {
            changed.push({ iid: entry.iid, from, to: entry.status });
        }
    }

    return { changed, added };
}

export function buildManifest(options: {
    source: string;
    entries: ManifestEntry[];
    previous: StaleManifest | null;
    now?: Date;
}): StaleManifest {
    return {
        _instructions: INSTRUCTIONS,
        source: options.source,
        generatedAt: (options.now ?? new Date()).toISOString(),
        previousRunAt: options.previous?.generatedAt ?? null,
        entries: [...options.entries].sort((a, b) => a.iid - b.iid),
    };
}

function reactionCell(entry: ManifestEntry): string {
    const parts: string[] = [];
    if (entry.reaction.notes) {
        parts.push(
            `${entry.reaction.notes} note(s), newest ${formatDate(entry.reaction.newestNoteAt)} by ${entry.reaction.newestNoteBy}`
        );
    }

    if (entry.reaction.newCommits) {
        parts.push(`new commits (${entry.reaction.shaAtContact.slice(0, 8)} → ${entry.reaction.shaNow.slice(0, 8)})`);
    }

    if (entry.reaction.draftChanged) {
        parts.push("draft flag changed");
    }

    if (entry.reaction.adoChanged) {
        parts.push(`ADO ${entry.reaction.adoChanged}`);
    }

    return parts.length ? parts.join("; ").replaceAll("|", "\\|") : "none";
}

export function renderManifestTable(entries: ManifestEntry[]): string {
    const header =
        "| MR | Author | Sent | Contacted | Days | Stale label | Reaction since | Status |\n|---|---|---|---|---:|---|---|---|";
    const body = [...entries]
        .sort((a, b) => a.iid - b.iid)
        .map(
            (e) =>
                `| [!${e.iid}](${e.webUrl}) | ${e.author} | ${e.sent.map((s) => s.kind).join(" + ") || "labels only"} | ${formatDate(e.contactedAt)} | ${e.daysSinceContact} | ${e.labels.staleLabel} | ${reactionCell(e)} | ${e.status} |`
        );

    return [header, ...body].join("\n");
}

export function manifestSummary(entries: ManifestEntry[]): string {
    const counts = new Map<ManifestStatus, number>();
    for (const entry of entries) {
        counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
    }

    const rows = MANIFEST_STATUSES.filter((s) => counts.get(s)).map(
        (s) => `| ${s} | ${counts.get(s)} | ${STATUS_MEANING[s]} |`
    );

    return ["| Status | MRs | Meaning |", "|---|---:|---|", ...rows].join("\n");
}
