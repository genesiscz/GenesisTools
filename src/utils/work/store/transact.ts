import type { Database } from "bun:sqlite";
import { SafeJSON } from "@genesiscz/utils/json";
import { errorDiagnostic, failReply, okReply, type Reply } from "@genesiscz/utils/output/reply";
import type { Change } from "../model/change";
import type { ItemId } from "../model/item";
import type { LegacyAction } from "../ports";
import { applyChange } from "./apply";
import { decide, type WorkCommand, type WriteEnv } from "./decide";
import { sqlView } from "./view";

/** What one transaction did; the service turns it into the reply of its verb. */
export interface WriteOutcome {
    items: ItemId[];
    changes: Change[];
    /** Writes for the old handoff log that the caller still has to run. */
    legacy: LegacyAction[];
    noop: boolean;
}

const REQUEST_DAYS = 30;

export function principalOf(env: WriteEnv): string {
    return env.actor.sessionId ?? `${env.actor.kind}:${env.actor.harness}`;
}

/** The stored reply of an earlier call with the same request id, marked as a replay. */
export function replayOf(db: Database, principal: string, requestId: string): Reply<unknown> | null {
    const row = db
        .query<{ reply: string }, [string, string]>("SELECT reply FROM requests WHERE principal = ? AND request_id = ?")
        .get(principal, requestId);

    if (row === null) {
        return null;
    }

    const reply = SafeJSON.parse(row.reply) as Reply<unknown>;
    return { ...reply, receipt: { changes: reply.receipt?.changes ?? [], requestId, replayed: true } };
}

export function storeReply(
    db: Database,
    principal: string,
    requestId: string,
    reply: Reply<unknown>,
    now: string
): void {
    db.run(
        `INSERT INTO requests (principal, request_id, reply, ts) VALUES (?, ?, ?, ?)
         ON CONFLICT (principal, request_id) DO UPDATE SET reply = excluded.reply`,
        [principal, requestId, SafeJSON.stringify(reply, { strict: true }), now]
    );
    const cutoff = new Date(Date.parse(now) - REQUEST_DAYS * 86_400_000).toISOString();
    db.run("DELETE FROM requests WHERE ts < ?", [cutoff]);
}

/**
 * One BEGIN IMMEDIATE: check the request id, decide, apply, keep the reply. `dryRun` stops after `decide` and
 * returns the changes it would write.
 */
export function transact(
    db: Database,
    command: WorkCommand,
    env: WriteEnv,
    options: { dryRun?: boolean; approvedLegacy?: LegacyAction[] } = {}
): Reply<WriteOutcome> | { replay: Reply<unknown> } {
    const principal = principalOf(env);
    db.run("BEGIN IMMEDIATE");

    try {
        if (env.request !== undefined) {
            const replay = replayOf(db, principal, env.request);

            if (replay !== null) {
                db.run("ROLLBACK");
                return { replay };
            }
        }

        const decision = decide(command, sqlView(db), env);

        if (!decision.ok) {
            db.run("ROLLBACK");
            return failReply(command.verb, decision.diagnostics, decision.next);
        }

        if (options.dryRun) {
            db.run("ROLLBACK");
            const preview = decision.changes.map((change, index) => ({ ...change, seq: -(index + 1) }));
            return okReply(
                command.verb,
                { items: decision.items, changes: preview, legacy: decision.legacy, noop: decision.noop === true },
                { diagnostics: decision.diagnostics, next: decision.next, dryRun: true }
            );
        }

        if (SafeJSON.stringify(decision.legacy) !== SafeJSON.stringify(options.approvedLegacy ?? [])) {
            db.run("ROLLBACK");
            return failReply(command.verb, [
                errorDiagnostic("WRITE_CHANGED", "The handoff actions changed during preflight. Retry the write."),
            ]);
        }

        const applied = decision.changes.map((change) => applyChange(db, change));
        const reply = okReply(
            command.verb,
            { items: decision.items, changes: applied, legacy: decision.legacy, noop: decision.noop === true },
            {
                diagnostics: decision.diagnostics,
                next: decision.next,
                receipt: {
                    changes: applied.map((c) => c.seq),
                    replayed: false,
                    ...(env.request !== undefined ? { requestId: env.request } : {}),
                },
            }
        );

        if (env.request !== undefined) {
            storeReply(db, principal, env.request, reply, env.now);
        }

        db.run("COMMIT");
        return reply;
    } catch (error) {
        db.run("ROLLBACK");
        throw error;
    }
}
