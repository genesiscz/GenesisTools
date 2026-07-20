import type { Handoff, HandoffPublicEvent } from "./types";

/** Canonical MCP `include` section names (Architecture). */
export const HANDOFF_INCLUDE_SECTIONS = [
    "tasks",
    "claimedBy",
    "comments",
    "attachments",
    "events",
    "postedBy",
    "postedByContext",
] as const;

export type HandoffIncludeSection = (typeof HANDOFF_INCLUDE_SECTIONS)[number];

const SECTION_SET = new Set<string>(HANDOFF_INCLUDE_SECTIONS);

/** editId-stripped handoff as returned to callers (matches PublicHandoff). */
export type PublicHandoffLike = Omit<Handoff, "editId"> & {
    attachments: (Handoff["attachments"][number] & { path?: string })[];
};

export function parseIncludeSections(raw: unknown): HandoffIncludeSection[] {
    if (!Array.isArray(raw)) {
        throw new Error(`include must be an array of section names — valid: ${HANDOFF_INCLUDE_SECTIONS.join(", ")}.`);
    }

    const out: HandoffIncludeSection[] = [];
    const unknown: string[] = [];

    for (const item of raw) {
        if (typeof item !== "string" || !SECTION_SET.has(item)) {
            unknown.push(typeof item === "string" ? item : String(item));
        } else if (!out.includes(item as HandoffIncludeSection)) {
            out.push(item as HandoffIncludeSection);
        }
    }

    if (unknown.length > 0) {
        throw new Error(
            `Unknown include section(s): ${unknown.join(", ")}. Valid: ${HANDOFF_INCLUDE_SECTIONS.join(", ")}.`
        );
    }

    return out;
}

/** Always-present cheap core fields (not gated by include). */
export type HandoffCoreProjection = {
    id: string;
    title: string;
    description?: string;
    status: Handoff["status"];
    project: string | null;
    target?: Handoff["target"];
    refs?: string[];
    tasksSummary: string;
    createdTs: string;
    updatedTs: string;
    finishedTs?: string;
};

export type ProjectedHandoff = HandoffCoreProjection & {
    tasks?: Handoff["tasks"];
    claimedBy?: Handoff["claimedBy"];
    comments?: Handoff["comments"];
    attachments?: PublicHandoffLike["attachments"];
    postedBy?: Handoff["postedBy"];
    postedByContext?: Handoff["postedByContext"];
    events?: HandoffPublicEvent[];
};

/** `progress()` string form — always on projected responses. */
export function tasksSummaryOf(h: Pick<Handoff, "tasks">): string {
    const total = h.tasks.length;
    const resolved = h.tasks.filter((t) => t.checked || t.denied).length;
    return `${resolved}/${total}`;
}

export function projectHandoff({
    handoff,
    sections,
    events,
}: {
    handoff: PublicHandoffLike;
    sections: HandoffIncludeSection[];
    events?: HandoffPublicEvent[];
}): ProjectedHandoff {
    const core: HandoffCoreProjection = {
        id: handoff.id,
        title: handoff.title,
        status: handoff.status,
        project: handoff.project,
        tasksSummary: tasksSummaryOf(handoff),
        createdTs: handoff.createdTs,
        updatedTs: handoff.updatedTs,
    };

    if (handoff.description !== undefined) {
        core.description = handoff.description;
    }

    if (handoff.target !== undefined) {
        core.target = handoff.target;
    }

    if (handoff.refs !== undefined) {
        core.refs = handoff.refs;
    }

    if (handoff.finishedTs !== undefined) {
        core.finishedTs = handoff.finishedTs;
    }

    const want = new Set(sections);
    const out: ProjectedHandoff = { ...core };

    if (want.has("tasks")) {
        out.tasks = handoff.tasks;
    }

    if (want.has("claimedBy")) {
        out.claimedBy = handoff.claimedBy;
    }

    if (want.has("comments")) {
        out.comments = handoff.comments;
    }

    if (want.has("attachments")) {
        out.attachments = handoff.attachments;
    }

    if (want.has("postedBy")) {
        out.postedBy = handoff.postedBy;
    }

    if (want.has("postedByContext")) {
        out.postedByContext = handoff.postedByContext;
    }

    if (want.has("events") && events !== undefined) {
        out.events = events;
    }

    return out;
}

/** True when include is exactly `["events"]` — bare `{events, info}` response (D5). */
export function isEventsOnlyInclude(sections: HandoffIncludeSection[]): boolean {
    return sections.length === 1 && sections[0] === "events";
}
