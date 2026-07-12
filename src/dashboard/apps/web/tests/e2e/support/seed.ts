import { SafeJSON } from "@app/utils/json";
import { E2E_USER_ID, genId, nowIso, withTestDb } from "./db";

/**
 * Generic insert. Keys are snake_case column names; JSON columns must be passed
 * already stringified. Returns the row object.
 *
 * Domain seeders below are the pattern to MIRROR for new features: a tiny typed
 * helper that fills user_id + timestamps + sane defaults and returns the id.
 */
export function insertRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
    return withTestDb((db) => {
        const cols = Object.keys(row);
        const placeholders = cols.map(() => "?").join(", ");
        db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`).run(
            ...cols.map((c) => row[c] as never)
        );
        return row;
    });
}

export function seedNote(opts: { title: string; body?: string; tags?: string[]; pinned?: boolean }): string {
    const id = genId("note");
    const now = nowIso();
    insertRow("notes", {
        id,
        user_id: E2E_USER_ID,
        title: opts.title,
        body: opts.body ?? "",
        tags: SafeJSON.stringify(opts.tags ?? []),
        pinned: opts.pinned ? 1 : 0,
        created_at: now,
        updated_at: now,
    });
    return id;
}
