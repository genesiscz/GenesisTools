import type { Handoff, HandoffActionResult, HandoffListRow } from "@app/handoff/types";

export type {
    Handoff,
    HandoffActionInput,
    HandoffActionResult,
    HandoffAttachment,
    HandoffClaim,
    HandoffComment,
    HandoffListRow,
    HandoffProof,
    HandoffStatus,
    HandoffTarget,
    HandoffTask,
    HandoffTaskInput,
} from "@app/handoff/types";

/** Route/tool response shape of a handoff: editId stripped, attachment paths resolved. */
export type PublicHandoff = Omit<Handoff, "editId"> & {
    attachments: (Handoff["attachments"][number] & { path?: string })[];
};

export interface HandoffListResponse {
    handoffs: HandoffListRow[];
    info: string[];
}

export interface HandoffGetResponse {
    handoff: PublicHandoff;
    editId?: string;
    info: string[];
}

export interface HandoffActionResponse {
    handoff: PublicHandoff;
    results: HandoffActionResult[];
    info: string[];
}

export interface HandoffPostResponse {
    handoff: PublicHandoff;
    editId: string;
    paste: { _agent: string; id: string; title: string; tasks: string };
    info: string[];
}

export interface HandoffStreamFrame {
    type?: "handoff";
    id: string;
    ev: string;
    ts: string;
}

export interface HandoffEventsResponse {
    events: HandoffPublicEvent[];
    total: number;
}

/** editId-stripped event from GET /api/handoff/events */
export type HandoffPublicEvent = {
    uid: string;
    id: string;
    ts: string;
    ev: string;
    by: {
        sessionId: string | null;
        sessionTitle: string | null;
        agent: string;
        via?: string;
        branch?: string | null;
        cwd?: string | null;
        repoRoot?: string | null;
        commitSha?: string | null;
    };
    [key: string]: unknown;
};
