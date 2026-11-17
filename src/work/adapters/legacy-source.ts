/** Reads the old handoff read model for the one backfill and for the parity check. */
import type { Database } from "bun:sqlite";
import { catchUpHandoffs, listHandoffEvents, listHandoffRows, openHandoffModel } from "@app/handoff/read-model";
import type { Handoff } from "@app/handoff/types";
import type { LegacyEventRef } from "@genesiscz/utils/work/legacy/shadow";

const PAGE = 1000;

export interface LegacySource {
    handoffs(): Handoff[];
    events(handoffId: string): LegacyEventRef[];
    close(): void;
}

/**
 * `catchUp: true` folds new log lines into the old read model first (what every old reader does); the parity check
 * passes false, so it reads and never writes.
 */
export function openLegacySource(options: { catchUp: boolean; dbPath?: string; base?: string }): LegacySource {
    const db: Database = openHandoffModel(options.dbPath);

    if (options.catchUp) {
        catchUpHandoffs(db, options.base);
    }

    return {
        handoffs: () => listHandoffRows(db, {}),
        events(handoffId) {
            const all: LegacyEventRef[] = [];
            let before: { ts: string; uid: string } | undefined;

            for (;;) {
                const page = listHandoffEvents({
                    db,
                    handoffId,
                    limit: PAGE,
                    ...(before !== undefined ? { before: before.ts, beforeUid: before.uid } : {}),
                });

                for (const event of page.events) {
                    all.push({
                        event,
                        outcome: event.outcome
                            ? {
                                  applied: event.outcome.applied,
                                  ...(event.outcome.assignedTaskIds
                                      ? { assignedTaskIds: event.outcome.assignedTaskIds }
                                      : {}),
                              }
                            : null,
                    });
                }

                const last = page.events[page.events.length - 1];

                if (page.events.length < PAGE || last === undefined) {
                    break;
                }

                before = { ts: last.ts, uid: last.uid };
            }

            return all.reverse();
        },
        close: () => db.close(),
    };
}
