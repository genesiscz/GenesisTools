import type { Actor, ItemId } from "./item";

/** The journal row, the mirror line and the work log are this one type. */
export type ChangeKind =
    | "created"
    | "edited"
    | "moved"
    | "claimed"
    | "released"
    | "commented"
    | "linked"
    | "unlinked"
    | "pointed"
    | "logged"
    | "delivered"
    | "paired"
    | "unpaired";

export type ChangeOrigin = { via: "local" } | { via: "legacy"; uid: string } | { via: "connector"; id: string };

/** One fact of the preflight context, with how it was found (P4 fills these). */
export interface ContextStampFact {
    path: string;
    value: string;
    method: "given" | "read" | "inferred";
    source: string;
}

export interface ContextStamp {
    facts: ContextStampFact[];
}

export interface Change {
    seq: number;
    v: 1;
    ts: string;
    item: ItemId;
    actor: Actor;
    kind: ChangeKind;
    payload: unknown;
    origin: ChangeOrigin;
    request?: string;
    stamp?: ContextStamp;
}

export type NewChange = Omit<Change, "seq">;
