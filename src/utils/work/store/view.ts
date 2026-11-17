import type { Database } from "bun:sqlite";
import type { Change } from "../model/change";
import type { Claim, Item, ItemId, Pointer, Reference } from "../model/item";
import {
    type ItemRow,
    rowToItem,
    selectChanges,
    selectClaims,
    selectItem,
    selectMemberBySlot,
    selectPointers,
    selectRefsFrom,
    selectRefsTo,
} from "./rows";

export interface Membership {
    handoff: ItemId;
    slot: string;
}

export interface Resolved {
    item: Item;
    /** Set when the ref named a slot of a handoff ("h_x:t3"). */
    via?: Membership;
}

/** What `decide` may read. A plain interface, so a test can give a fake one. */
export interface StoreView {
    item(id: string): Item | null;
    resolve(ref: string): Resolved | null;
    refsFrom(id: string): Reference[];
    refsTo(id: string): Reference[];
    memberships(id: string): Membership[];
    parentOf(id: string): ItemId | null;
    claims(where: { item?: string; sessionIds?: string[]; active?: boolean }): Claim[];
    changes(id: string): Change[];
    pointers(id: string): Pointer[];
}

/** "h_x:t5" → { handoff: "h_x", slot: "t5" }. */
export function splitSlotRef(ref: string): { handoff: string; slot: string } | null {
    const match = /^(h_[a-z0-9]+):([A-Za-z0-9_-]+)$/.exec(ref);
    return match ? { handoff: match[1], slot: match[2] } : null;
}

export function normalizeRef(ref: string): string {
    return ref.trim();
}

export function sqlView(db: Database): StoreView {
    const view: StoreView = {
        item: (id) => selectItem(db, id),
        resolve(raw) {
            const ref = normalizeRef(raw);
            const direct = selectItem(db, ref);
            const slotRef = splitSlotRef(ref);

            if (slotRef !== null) {
                const member = selectMemberBySlot(db, slotRef.handoff, slotRef.slot);
                const item = member !== null ? selectItem(db, member) : direct;

                if (item === null) {
                    return null;
                }

                return {
                    item,
                    via: { handoff: slotRef.handoff as ItemId, slot: slotRef.slot },
                };
            }

            return direct === null ? null : { item: direct };
        },
        refsFrom: (id) => selectRefsFrom(db, id),
        refsTo: (id) => selectRefsTo(db, id),
        memberships: (id) =>
            selectRefsTo(db, id)
                .filter((ref) => ref.kind === "member" && ref.slot !== undefined)
                .map((ref) => ({ handoff: ref.from, slot: ref.slot as string })),
        parentOf: (id) => selectRefsFrom(db, id).find((ref) => ref.kind === "parent")?.to ?? null,
        claims: (where) => selectClaims(db, where),
        changes: (id) => selectChanges(db, id),
        pointers: (id) => selectPointers(db, id),
    };

    return view;
}

export interface ListFilter {
    project?: string;
    states?: string[];
    types?: string[];
    severities?: string[];
    tag?: string;
    ids?: string[];
    workerSession?: string;
    limit?: number;
}

/** One indexed query; rows carry no relations. */
export function selectItems(db: Database, filter: ListFilter): Item[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    const inList = (column: string, values: string[] | undefined) => {
        if (values === undefined || values.length === 0) {
            return;
        }

        clauses.push(`${column} IN (${values.map(() => "?").join(", ")})`);
        params.push(...values);
    };

    if (filter.project !== undefined) {
        clauses.push("project = ?");
        params.push(filter.project);
    }

    inList("state", filter.states);
    inList("type", filter.types);
    inList("severity", filter.severities);
    inList("id", filter.ids);

    if (filter.tag !== undefined) {
        clauses.push("EXISTS (SELECT 1 FROM json_each(items.tags) WHERE json_each.value = ?)");
        params.push(filter.tag);
    }

    if (filter.workerSession !== undefined) {
        clauses.push("json_extract(worker, '$.sessionId') = ?");
        params.push(filter.workerSession);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit ?? 500;
    params.push(limit);
    return db
        .query<ItemRow, (string | number)[]>(`SELECT * FROM items${where} ORDER BY created_ts, id LIMIT ?`)
        .all(...params)
        .map(rowToItem);
}
