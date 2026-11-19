/** Reads the old handoff read model for the one backfill and for the parity check. */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
// lint-rules-ignore: the one backfill and the parity check read the old handoff read model until the switch (spec P1, P10)
import {
    catchUpHandoffs,
    handoffDbPath,
    iterateHandoffEvents,
    listHandoffRows,
    openHandoffModel,
} from "@app/handoff/read-model";
// lint-rules-ignore: the one backfill and the parity check read the old handoff read model until the switch (spec P1, P10)
import type { Handoff } from "@app/handoff/types";
import type { LegacyEventRef } from "@genesiscz/utils/work/legacy/shadow";

export interface LegacySource {
    handoffs(): Handoff[];
    events(handoffId: string): Iterable<LegacyEventRef>;
    close(): void;
}

/**
 * `catchUp: true` folds new log lines into the old read model first (what every old reader does); the parity check
 * passes false, so it reads and never writes.
 */
export function openLegacySource(options: { catchUp: boolean; dbPath?: string; base?: string }): LegacySource {
    const path = options.dbPath ?? handoffDbPath();
    const db = options.catchUp
        ? openHandoffModel(path)
        : existsSync(path)
          ? new Database(path, { readonly: true })
          : null;

    if (db === null) {
        return { handoffs: () => [], events: () => [], close: () => {} };
    }

    if (options.catchUp) {
        catchUpHandoffs(db, options.base);
    }

    return {
        handoffs: () =>
            db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'handoffs'").get() !== null
                ? listHandoffRows(db, {})
                : [],
        *events(handoffId) {
            for (const event of iterateHandoffEvents(db, handoffId)) {
                yield { event, outcome: event.outcome ?? null };
            }
        },
        close: () => db.close(),
    };
}
