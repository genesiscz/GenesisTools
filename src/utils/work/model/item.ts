import type { CallerHost } from "@genesiscz/utils/agent/identity/types";
import type { ItemState, ItemType, RefKind, Severity } from "./vocab";

/** "h_fd9bxv3z" (a handoff), "h_fd9bxv3z:t5" (born in a handoff, kept for good), "w_k3m9x2qa" (new). */
export type ItemId = string & { readonly __brand: "ItemId" };

export function asItemId(value: string): ItemId {
    return value as ItemId;
}

export interface ItemFields {
    where?: string;
    why?: string;
    userSees?: string;
    cost?: string;
    measured?: string;
    existedBefore?: boolean;
    production?: boolean;
    remind?: { at: string; label?: string }[];
}

export const FIELD_NAMES = [
    "where",
    "why",
    "userSees",
    "cost",
    "measured",
    "existedBefore",
    "production",
    "remind",
] as const satisfies readonly (keyof ItemFields)[];

/** A snapshot of `whoIsCalling` with the facets cwd, git, title, model, host. */
export interface Actor {
    kind: "agent" | "owner" | "connector" | "legacy";
    harness: string;
    sessionId: string | null;
    sessionTitle: string | null;
    model: string | null;
    host: CallerHost | null;
    subagentId: string | null;
    project: string | null;
    repoRoot: string | null;
    branch: string | null;
    commitSha: string | null;
}

export type WorkerStamp = Pick<Actor, "kind" | "harness" | "sessionId" | "sessionTitle" | "model" | "host">;

export function stampOf(actor: Actor): WorkerStamp {
    return {
        kind: actor.kind,
        harness: actor.harness,
        sessionId: actor.sessionId,
        sessionTitle: actor.sessionTitle,
        model: actor.model,
        host: actor.host,
    };
}

export interface Item {
    id: ItemId;
    type: ItemType;
    state: ItemState;
    project: string;
    rev: number;
    title: string;
    body?: string;
    acceptance?: string;
    severity?: Severity;
    for?: string;
    tags: string[];
    fields: ItemFields;
    /** The last actor that claimed or finished it; no agent types it. */
    worker?: WorkerStamp;
    createdBy: Actor;
    createdTs: string;
    updatedTs: string;
    closedTs?: string;
}

/** `parent`: at most one per item (the plan tree). `member`: handoff → item, with a slot ("t5"); many per item. */
export interface Reference {
    from: ItemId;
    kind: RefKind;
    to: ItemId;
    slot?: string;
    by: WorkerStamp;
    ts: string;
}

/** Item → a thing outside the store: "pr:owner/repo#42", "commit:abc1234", "file:src/x.ts:42", "decision:…". */
export interface Pointer {
    kind: string;
    target: string;
    meta?: Record<string, string>;
}

/** One live or past claim of an item (a handoff claim of the old store lands here too). */
export interface Claim {
    item: ItemId;
    by: WorkerStamp;
    ts: string;
    active: boolean;
}
