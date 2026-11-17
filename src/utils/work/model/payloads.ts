import type { DeliveryReceipt } from "../ports";
import type { ItemFields, Pointer } from "./item";
import type { ItemState, ItemType, LogResult, RefKind, Severity } from "./vocab";

/** The fields a `created` change carries; the id, the actor and the time come from the change itself. */
export interface CreatedPayload {
    type: ItemType;
    state: ItemState;
    project: string;
    title: string;
    body?: string;
    acceptance?: string;
    severity?: Severity;
    for?: string;
    tags: string[];
    fields: ItemFields;
}

/** A partial update. `null` clears an optional field. */
export interface ItemPatch {
    type?: ItemType;
    title?: string;
    body?: string | null;
    acceptance?: string | null;
    severity?: Severity | null;
    for?: string | null;
    project?: string;
    tags?: string[];
    fields?: Partial<ItemFields>;
}

export interface EditedPayload {
    set: ItemPatch;
    /** True when the shadow ingest corrected a row to the old read model. */
    reconcile?: boolean;
}

export interface MovedPayload {
    from: ItemState;
    to: ItemState;
    why?: string;
    proof?: { text: string; commits?: string[] };
    reconcile?: boolean;
}

export interface CommentedPayload {
    text: string;
}

export interface LinkPayload {
    kind: RefKind;
    to: string;
    slot?: string;
}

export interface PointedPayload {
    pointer: Pointer;
}

export interface LoggedPayload {
    result: LogResult;
    note?: string;
    measured?: string;
}

export interface DeliveredPayload {
    key: string;
    receipt: DeliveryReceipt;
}

export interface PairedPayload {
    connector: string;
    remoteKey: string;
}
