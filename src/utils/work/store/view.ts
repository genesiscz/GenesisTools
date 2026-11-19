import type { Database } from "bun:sqlite";
import { SafeJSON } from "@genesiscz/utils/json";
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
    roleEvidence(id: string, self: string | null, lineage: readonly string[]): { worker: boolean; lead: boolean };
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
            const slotRef = splitSlotRef(ref);

            if (slotRef !== null) {
                const member = selectMemberBySlot(db, slotRef.handoff, slotRef.slot);
                const item = selectItem(db, member ?? ref);

                if (item === null) {
                    return null;
                }

                return {
                    item,
                    via: { handoff: slotRef.handoff as ItemId, slot: slotRef.slot },
                };
            }

            const direct = selectItem(db, ref);
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
        roleEvidence(id, self, lineage) {
            const evidence = db
                .query<{ worker: number; lead: number }, [string, string, string | null, string]>(`
                WITH RECURSIVE leads AS (SELECT value FROM json_each(?)),
                start(id) AS (VALUES (?)),
                ancestors(id) AS (
                    SELECT id FROM start
                    UNION
                    SELECT CASE r.kind WHEN 'member' THEN r.from_id ELSE r.to_id END
                    FROM ancestors a JOIN refs r ON
                        (r.kind = 'member' AND r.to_id = a.id)
                        OR (r.kind IN ('parent', 'spotted-in') AND r.from_id = a.id)
                    JOIN items i ON i.id = CASE r.kind WHEN 'member' THEN r.from_id ELSE r.to_id END
                    WHERE EXISTS (SELECT 1 FROM leads)
                )
                SELECT EXISTS (
                    SELECT 1 FROM claims c
                    WHERE c.session_id = ? AND c.active = 1
                      AND (c.item = start.id OR c.item IN (SELECT from_id FROM refs WHERE kind = 'member' AND to_id = start.id))
                ) AS worker,
                EXISTS (
                    SELECT 1 FROM ancestors a JOIN items i ON i.id = a.id
                    WHERE a.id <> ? AND (
                        json_extract(i.created_by, '$.sessionId') IN (SELECT value FROM leads)
                        OR EXISTS (
                            SELECT 1 FROM claims c WHERE c.item = a.id AND c.active = 1
                               AND c.session_id IN (SELECT value FROM leads)
                        )
                    )
                ) AS lead
                FROM start
            `)
                .get(SafeJSON.stringify(lineage), id, self, id);
            return { worker: evidence?.worker === 1, lead: evidence?.lead === 1 };
        },
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
    after?: string;
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
    if (filter.after !== undefined) {
        clauses.push("(created_ts, id) > (SELECT created_ts, id FROM items WHERE id = ?)");
        params.push(filter.after);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const requested = filter.limit ?? 500;
    const limit = Number.isFinite(requested) ? Math.max(0, Math.min(5000, Math.trunc(requested))) : 500;
    params.push(limit);
    return db
        .query<ItemRow, (string | number)[]>(`SELECT * FROM items${where} ORDER BY created_ts, id LIMIT ?`)
        .all(...params)
        .map(rowToItem);
}
