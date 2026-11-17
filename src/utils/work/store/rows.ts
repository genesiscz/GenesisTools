import type { Database } from "bun:sqlite";
import { SafeJSON } from "@genesiscz/utils/json";
import type { Change, ChangeKind, ChangeOrigin, ContextStamp } from "../model/change";
import type { Actor, Claim, Item, ItemFields, ItemId, Pointer, Reference, WorkerStamp } from "../model/item";
import { asItemId } from "../model/item";
import type { ItemState, ItemType, RefKind, Severity } from "../model/vocab";

export interface ItemRow {
    id: string;
    type: string;
    state: string;
    project: string;
    rev: number;
    title: string;
    body: string | null;
    acceptance: string | null;
    severity: string | null;
    for_who: string | null;
    tags: string;
    fields: string;
    worker: string | null;
    created_by: string;
    created_ts: string;
    updated_ts: string;
    closed_ts: string | null;
}

function parse<T>(text: string): T {
    return SafeJSON.parse(text) as T;
}

export function rowToItem(row: ItemRow): Item {
    const item: Item = {
        id: asItemId(row.id),
        type: row.type as ItemType,
        state: row.state as ItemState,
        project: row.project,
        rev: row.rev,
        title: row.title,
        tags: parse<string[]>(row.tags),
        fields: parse<ItemFields>(row.fields),
        createdBy: parse<Actor>(row.created_by),
        createdTs: row.created_ts,
        updatedTs: row.updated_ts,
    };

    if (row.body !== null) {
        item.body = row.body;
    }

    if (row.acceptance !== null) {
        item.acceptance = row.acceptance;
    }

    if (row.severity !== null) {
        item.severity = row.severity as Severity;
    }

    if (row.for_who !== null) {
        item.for = row.for_who;
    }

    if (row.worker !== null) {
        item.worker = parse<WorkerStamp>(row.worker);
    }

    if (row.closed_ts !== null) {
        item.closedTs = row.closed_ts;
    }

    return item;
}

interface RefRow {
    from_id: string;
    kind: string;
    to_id: string;
    slot: string | null;
    by: string;
    ts: string;
}

export function rowToRef(row: RefRow): Reference {
    const ref: Reference = {
        from: asItemId(row.from_id),
        kind: row.kind as RefKind,
        to: asItemId(row.to_id),
        by: parse<WorkerStamp>(row.by),
        ts: row.ts,
    };

    if (row.slot !== null) {
        ref.slot = row.slot;
    }

    return ref;
}

interface ChangeRow {
    seq: number;
    ts: string;
    item: string;
    actor: string;
    kind: string;
    payload: string;
    origin: string;
    request: string | null;
    stamp: string | null;
}

export function rowToChange(row: ChangeRow): Change {
    const change: Change = {
        seq: row.seq,
        v: 1,
        ts: row.ts,
        item: asItemId(row.item),
        actor: parse<Actor>(row.actor),
        kind: row.kind as ChangeKind,
        payload: parse<unknown>(row.payload),
        origin: parse<ChangeOrigin>(row.origin),
    };

    if (row.request !== null) {
        change.request = row.request;
    }

    if (row.stamp !== null) {
        change.stamp = parse<ContextStamp>(row.stamp);
    }

    return change;
}

const CHANGE_COLUMNS = "seq, ts, item, actor, kind, payload, origin, request, stamp";

export function selectItem(db: Database, id: string): Item | null {
    const row = db.query<ItemRow, [string]>("SELECT * FROM items WHERE id = ?").get(id);
    return row === null ? null : rowToItem(row);
}

export function selectRefsFrom(db: Database, id: string): Reference[] {
    return db
        .query<RefRow, [string]>("SELECT from_id, kind, to_id, slot, by, ts FROM refs WHERE from_id = ? ORDER BY id")
        .all(id)
        .map(rowToRef);
}

export function selectRefsTo(db: Database, id: string): Reference[] {
    return db
        .query<RefRow, [string]>("SELECT from_id, kind, to_id, slot, by, ts FROM refs WHERE to_id = ? ORDER BY id")
        .all(id)
        .map(rowToRef);
}

export function selectMemberBySlot(db: Database, handoff: string, slot: string): string | null {
    const row = db
        .query<{ to_id: string }, [string, string]>(
            "SELECT to_id FROM refs WHERE kind = 'member' AND from_id = ? AND slot = ?"
        )
        .get(handoff, slot);
    return row?.to_id ?? null;
}

export function selectChanges(db: Database, item: string, limit = 500): Change[] {
    return db
        .query<ChangeRow, [string, number]>(
            `SELECT ${CHANGE_COLUMNS} FROM changes WHERE item = ? ORDER BY seq DESC LIMIT ?`
        )
        .all(item, limit)
        .map(rowToChange)
        .reverse();
}

export function selectChangesAfter(db: Database, seq: number, limit: number): Change[] {
    return db
        .query<ChangeRow, [number, number]>(`SELECT ${CHANGE_COLUMNS} FROM changes WHERE seq > ? ORDER BY seq LIMIT ?`)
        .all(seq, limit)
        .map(rowToChange);
}

export function selectPointers(db: Database, item: string): Pointer[] {
    return db
        .query<{ kind: string; target: string; meta: string | null }, [string]>(
            "SELECT kind, target, meta FROM pointers WHERE item = ? ORDER BY ts"
        )
        .all(item)
        .map((row) => {
            const pointer: Pointer = { kind: row.kind, target: row.target };

            if (row.meta !== null) {
                pointer.meta = parse<Record<string, string>>(row.meta);
            }

            return pointer;
        });
}

export function selectClaims(db: Database, where: { item?: string; sessionIds?: string[]; active?: boolean }): Claim[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (where.item !== undefined) {
        clauses.push("item = ?");
        params.push(where.item);
    }

    if (where.sessionIds !== undefined) {
        if (where.sessionIds.length === 0) {
            return [];
        }

        clauses.push(`session_id IN (${where.sessionIds.map(() => "?").join(", ")})`);
        params.push(...where.sessionIds);
    }

    if (where.active !== undefined) {
        clauses.push("active = ?");
        params.push(where.active ? 1 : 0);
    }

    const sql = `SELECT item, by, ts, active FROM claims${clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY ts`;
    return db
        .query<{ item: string; by: string; ts: string; active: number }, (string | number)[]>(sql)
        .all(...params)
        .map((row) => ({
            item: asItemId(row.item),
            by: parse<WorkerStamp>(row.by),
            ts: row.ts,
            active: row.active === 1,
        }));
}

export function toItemIds(values: string[]): ItemId[] {
    return values.map(asItemId);
}
