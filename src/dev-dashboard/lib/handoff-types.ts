import type { Handoff, HandoffActionResult, HandoffListRow } from "@app/handoff/types";

export type {
    Handoff,
    HandoffActionInput,
    HandoffActionResult,
    HandoffAttachment,
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
    id: string;
    ev: string;
    ts: string;
}
