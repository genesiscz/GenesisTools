import { type ProjectApi, projectBase, restGet, restGetPaginated } from "@app/gitlab/lib/client";

export interface MrNote {
    id: number;
    author: string;
    createdAt: string;
    updatedAt: string;
    system: boolean;
    body: string;
}

export interface MrSummary {
    iid: number;
    title: string;
    description: string;
    author: { username: string; name: string; id: number; state: string };
    sourceBranch: string;
    targetBranch: string;
    createdAt: string;
    updatedAt: string;
    draft: boolean;
    state: string;
    labels: string[];
    webUrl: string;
    hasConflicts: boolean;
    detailedMergeStatus: string;
    userNotesCount: number;
    sha: string;
}

export interface MrWithNotes extends MrSummary {
    /** Newest note first. */
    notes: MrNote[];
    lastHumanNote: MrNote | null;
}

interface RawMr {
    iid: number;
    title: string;
    description: string | null;
    author: { username: string; name: string; id: number; state: string };
    source_branch: string;
    target_branch: string;
    created_at: string;
    updated_at: string;
    draft: boolean;
    state: string;
    labels: string[];
    web_url: string;
    has_conflicts: boolean;
    detailed_merge_status: string;
    user_notes_count: number;
    sha: string;
}

interface RawNote {
    id: number;
    author: { username: string };
    created_at: string;
    updated_at: string;
    system: boolean;
    body: string;
}

function mrBase(api: ProjectApi): string {
    return `${projectBase(api)}/merge_requests`;
}

function toSummary(raw: RawMr): MrSummary {
    return {
        iid: raw.iid,
        title: raw.title,
        description: raw.description ?? "",
        author: { username: raw.author.username, name: raw.author.name, id: raw.author.id, state: raw.author.state },
        sourceBranch: raw.source_branch,
        targetBranch: raw.target_branch,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
        draft: raw.draft,
        state: raw.state,
        labels: raw.labels,
        webUrl: raw.web_url,
        hasConflicts: raw.has_conflicts,
        detailedMergeStatus: raw.detailed_merge_status,
        userNotesCount: raw.user_notes_count,
        sha: raw.sha,
    };
}

function toNote(raw: RawNote): MrNote {
    return {
        id: raw.id,
        author: raw.author.username,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
        system: raw.system,
        body: raw.body,
    };
}

export async function listOpenMrs(api: ProjectApi): Promise<MrSummary[]> {
    const raw = await restGetPaginated<RawMr>(api, `${mrBase(api)}?state=opened&order_by=created_at&sort=asc`);

    return raw.map(toSummary);
}

export async function fetchMr(api: ProjectApi, iid: number): Promise<MrWithNotes> {
    const raw = await restGet<RawMr>(api, `${mrBase(api)}/${iid}`);
    const notes = await fetchMrNotes(api, iid);

    return withNotes(toSummary(raw), notes);
}

/**
 * Every note on the MR, newest first. One `per_page=100` request lost everything past the first
 * page, including the first human note `noteWindow` promises to keep, and activity checks then
 * judged a thread they had only partly read.
 */
export async function fetchMrNotes(api: ProjectApi, iid: number): Promise<MrNote[]> {
    const raw = await restGetPaginated<RawNote>(api, `${mrBase(api)}/${iid}/notes?sort=desc&order_by=updated_at`);

    return raw.map(toNote);
}

export function withNotes(mr: MrSummary, notes: MrNote[]): MrWithNotes {
    return { ...mr, notes, lastHumanNote: notes.find((n) => !n.system) ?? null };
}

/**
 * MRs carrying the work-item id: any state via title/description search, plus open MRs whose
 * source branch carries it (GitLab search does not cover branch names). Pass `open` when the
 * caller already holds the open list, to save one paginated call per id.
 */
export async function findMrsByWorkItemId(api: ProjectApi, id: number, open?: MrSummary[]): Promise<MrSummary[]> {
    const idText = String(id);
    const searched = (
        await restGetPaginated<RawMr>(
            api,
            `${mrBase(api)}?state=all&search=${idText}&in=title,description&order_by=created_at&sort=asc`
        )
    ).map(toSummary);
    const opened = open ?? (await restGetPaginated<RawMr>(api, `${mrBase(api)}?state=opened`)).map(toSummary);
    const merged = new Map<number, MrSummary>();

    for (const mr of [...searched, ...opened]) {
        if (mr.title.includes(idText) || mr.sourceBranch.includes(idText) || mr.description.includes(idText)) {
            merged.set(mr.iid, mr);
        }
    }

    return [...merged.values()].sort((a, b) => a.iid - b.iid);
}

export interface MrApprovals {
    approved: boolean;
    approvedBy: string[];
}

interface RawApprovals {
    approved: boolean;
    approved_by: Array<{ user: { username: string } }>;
}

/** GitLab files approvals as system notes, so the note window can hide them; this endpoint cannot. */
export async function fetchMrApprovals(api: ProjectApi, iid: number): Promise<MrApprovals> {
    const raw = await restGet<RawApprovals>(api, `${mrBase(api)}/${iid}/approvals`);

    return { approved: raw.approved, approvedBy: raw.approved_by.map((a) => a.user.username) };
}
