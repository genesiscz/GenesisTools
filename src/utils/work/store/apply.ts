import type { Database } from "bun:sqlite";
import { SafeJSON } from "@genesiscz/utils/json";
import type { Change, NewChange } from "../model/change";
import { stampOf } from "../model/item";
import type {
    CreatedPayload,
    EditedPayload,
    LinkPayload,
    MovedPayload,
    PairedPayload,
    PointedPayload,
    UnpairedPayload,
} from "../model/payloads";
import { selectItem } from "./rows";

function json(value: unknown): string {
    return SafeJSON.stringify(value, { strict: true });
}

/** States after which an item counts as closed. */
const CLOSED = new Set(["done", "dropped"]);

function bump(db: Database, change: NewChange): void {
    db.run("UPDATE items SET rev = rev + 1, updated_ts = ? WHERE id = ?", [change.ts, change.item]);
}

function syncFts(db: Database, id: string): void {
    db.run("DELETE FROM items_fts WHERE id = ?", [id]);
    db.run("INSERT INTO items_fts (id, title, body) SELECT id, title, COALESCE(body, '') FROM items WHERE id = ?", [
        id,
    ]);
}

function applyCreated(db: Database, change: NewChange): void {
    const p = change.payload as CreatedPayload;

    if (selectItem(db, change.item) !== null) {
        throw new Error(`work store: item ${change.item} already exists`);
    }

    db.run(
        `INSERT INTO items (id, type, state, project, rev, title, body, acceptance, severity, for_who, tags, fields,
                            worker, created_by, created_ts, updated_ts, closed_ts)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        [
            change.item,
            p.type,
            p.state,
            p.project,
            p.title,
            p.body ?? null,
            p.acceptance ?? null,
            p.severity ?? null,
            p.for ?? null,
            json(p.tags),
            json(p.fields),
            json(change.actor),
            change.ts,
            change.ts,
            CLOSED.has(p.state) ? change.ts : null,
        ]
    );
    syncFts(db, change.item);
}

const PATCH_COLUMNS: Record<string, string> = {
    type: "type",
    title: "title",
    body: "body",
    acceptance: "acceptance",
    severity: "severity",
    for: "for_who",
    project: "project",
};

function applyEdited(db: Database, change: NewChange): void {
    const { set } = change.payload as EditedPayload;
    const item = selectItem(db, change.item);

    if (item === null) {
        throw new Error(`work store: edit of a missing item ${change.item}`);
    }

    for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
        const value = (set as Record<string, unknown>)[key];

        if (value !== undefined) {
            db.run(`UPDATE items SET ${column} = ? WHERE id = ?`, [value as string | null, change.item]);
        }
    }

    if (set.tags !== undefined) {
        db.run("UPDATE items SET tags = ? WHERE id = ?", [json(set.tags), change.item]);
    }

    if (set.fields !== undefined) {
        db.run("UPDATE items SET fields = ? WHERE id = ?", [json({ ...item.fields, ...set.fields }), change.item]);
    }

    syncFts(db, change.item);
}

function applyMoved(db: Database, change: NewChange): void {
    const p = change.payload as MovedPayload;
    db.run("UPDATE items SET state = ?, closed_ts = ? WHERE id = ?", [
        p.to,
        CLOSED.has(p.to) ? change.ts : null,
        change.item,
    ]);

    if (p.to === "done" && change.actor.kind !== "legacy") {
        db.run("UPDATE items SET worker = ? WHERE id = ?", [json(stampOf(change.actor)), change.item]);
    }
}

function applyClaim(db: Database, change: NewChange, active: boolean): void {
    const session = change.actor.sessionId ?? `${change.actor.harness}:unknown`;
    db.run(
        `INSERT INTO claims (item, session_id, by, ts, active) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (item, session_id) DO UPDATE SET by = excluded.by, ts = excluded.ts, active = excluded.active`,
        [change.item, session, json(stampOf(change.actor)), change.ts, active ? 1 : 0]
    );

    if (active) {
        db.run("UPDATE items SET worker = ? WHERE id = ?", [json(stampOf(change.actor)), change.item]);
    }
}

function applyLinked(db: Database, change: NewChange): void {
    const p = change.payload as LinkPayload;
    db.run("INSERT INTO refs (from_id, kind, to_id, slot, by, ts) VALUES (?, ?, ?, ?, ?, ?)", [
        change.item,
        p.kind,
        p.to,
        p.slot ?? null,
        json(stampOf(change.actor)),
        change.ts,
    ]);
}

function applyUnlinked(db: Database, change: NewChange): void {
    const p = change.payload as LinkPayload;

    if (p.slot !== undefined) {
        db.run("DELETE FROM refs WHERE from_id = ? AND kind = ? AND to_id = ? AND slot = ?", [
            change.item,
            p.kind,
            p.to,
            p.slot,
        ]);
        return;
    }

    db.run("DELETE FROM refs WHERE from_id = ? AND kind = ? AND to_id = ?", [change.item, p.kind, p.to]);
}

function applyPointed(db: Database, change: NewChange): void {
    const { pointer } = change.payload as PointedPayload;
    db.run(
        `INSERT INTO pointers (item, kind, target, meta, ts) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (item, kind, target) DO UPDATE SET meta = excluded.meta`,
        [change.item, pointer.kind, pointer.target, pointer.meta ? json(pointer.meta) : null, change.ts]
    );
}

function applyPaired(db: Database, change: NewChange): void {
    const { pairing } = change.payload as PairedPayload;
    db.run(
        `INSERT INTO pairings (item, connector, remote_key, born, origin, state, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (item, connector) DO UPDATE SET remote_key = excluded.remote_key, born = excluded.born,
             origin = excluded.origin, state = excluded.state, updated_ts = excluded.updated_ts`,
        [
            change.item,
            pairing.connector,
            pairing.remoteKey,
            pairing.born,
            json({ facts: pairing.origin, ...(pairing.note !== undefined ? { note: pairing.note } : {}) }),
            pairing.state,
            change.ts,
        ]
    );
}

/**
 * The only code that changes item rows. It writes the journal entry and its effect in the caller's transaction, so
 * a row and its history never disagree.
 */
export function applyChange(db: Database, change: NewChange): Change {
    switch (change.kind) {
        case "created":
            applyCreated(db, change);
            break;
        case "edited":
            applyEdited(db, change);
            break;
        case "moved":
            applyMoved(db, change);
            break;
        case "claimed":
            applyClaim(db, change, true);
            break;
        case "released":
            applyClaim(db, change, false);
            break;
        case "linked":
            applyLinked(db, change);
            break;
        case "unlinked":
            applyUnlinked(db, change);
            break;
        case "pointed":
            applyPointed(db, change);
            break;
        case "paired":
            applyPaired(db, change);
            break;
        case "unpaired":
            db.run("DELETE FROM pairings WHERE item = ? AND connector = ?", [
                change.item,
                (change.payload as UnpairedPayload).connector,
            ]);
            break;
        case "commented":
        case "logged":
        case "delivered":
            break;
    }

    if (change.kind !== "created") {
        bump(db, change);
    }

    const result = db.run(
        `INSERT INTO changes (v, ts, item, actor, kind, payload, origin, request, stamp)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            change.ts,
            change.item,
            json(change.actor),
            change.kind,
            json(change.payload ?? null),
            json(change.origin),
            change.request ?? null,
            change.stamp ? json(change.stamp) : null,
        ]
    );

    return { ...change, seq: Number(result.lastInsertRowid) };
}
