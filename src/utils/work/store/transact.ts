import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { SafeJSON } from "@genesiscz/utils/json";
import { errorDiagnostic, failReply, okReply, type Reply } from "@genesiscz/utils/output/reply";
import type { Change } from "../model/change";
import type { Item, ItemId } from "../model/item";
import type { LegacyAction, LegacyWriteResult } from "../ports";
import { applyChange } from "./apply";
import { decide, type WorkCommand, type WriteEnv } from "./decide";
import { journalHead, selectChangesAfter, selectItem } from "./rows";
import { sqlView } from "./view";

/** What one transaction did; the service turns it into the reply of its verb. */
export interface WriteOutcome {
    items: ItemId[];
    changes: Change[];
    /** Writes for the old handoff log that the caller still has to run. */
    legacy: LegacyAction[];
    completedLegacy?: PendingWrite["completed"];
    noop: boolean;
    projected?: Item[];
}

const REQUEST_DAYS = 30;

export function principalOf(env: WriteEnv): string {
    return env.actor.sessionId ?? `${env.actor.kind}:${env.actor.harness}`;
}

export interface PendingWrite {
    kind: "work.pending";
    operationId: string;
    outcome: Reply<WriteOutcome>;
    completed: (LegacyWriteResult & { action: LegacyAction["action"] })[];
    lease?: { token: string; until: number };
}

export function requestOf(db: Database, principal: string, requestId: string): Reply<unknown> | PendingWrite | null {
    const row = db
        .query<{ reply: string }, [string, string]>("SELECT reply FROM requests WHERE principal = ? AND request_id = ?")
        .get(principal, requestId);
    return row === null ? null : (SafeJSON.parse(row.reply) as Reply<unknown> | PendingWrite);
}

function isOldOutcome(value: unknown): value is WriteOutcome {
    if (typeof value !== "object" || value === null || !("items" in value) || !Array.isArray(value.items)) {
        return false;
    }

    return (
        value.items.some((item: unknown) => typeof item === "string") ||
        ("legacy" in value &&
            Array.isArray(value.legacy) &&
            value.legacy.some((action: unknown) => typeof action === "object" && action !== null && !("ok" in action)))
    );
}

/** Public replay only. Older stored transaction outcomes need deliberate reconciliation. */
export function replayOf(db: Database, principal: string, requestId: string): Reply<unknown> | null {
    const reply = requestOf(db, principal, requestId);

    if (reply === null || "kind" in reply) {
        return null;
    }

    const receipt = { changes: reply.receipt?.changes ?? [], requestId, replayed: true };

    if (reply.ok && isOldOutcome(reply.data)) {
        if (reply.data.legacy.length > 0) {
            return {
                ...failReply(reply.verb, [
                    errorDiagnostic(
                        "REQUEST_NEEDS_RECONCILIATION",
                        "An earlier version may have started this handoff write. Inspect the receipt and handoff before retrying."
                    ),
                ]),
                receipt,
            };
        }

        return {
            ...reply,
            data: {
                items: reply.data.items.map((id) => selectItem(db, id)).filter((item) => item !== null),
                changes: receipt.changes,
                ...(reply.data.noop ? { noop: true } : {}),
            },
            receipt,
        };
    }

    return { ...reply, receipt };
}

export function storeReply(
    db: Database,
    principal: string,
    requestId: string,
    reply: Reply<unknown> | PendingWrite,
    now: string
): void {
    db.run(
        `INSERT INTO requests (principal, request_id, reply, ts) VALUES (?, ?, ?, ?)
         ON CONFLICT (principal, request_id) DO UPDATE SET reply = excluded.reply, ts = excluded.ts`,
        [principal, requestId, SafeJSON.stringify(reply, { strict: true }), now]
    );
    const cutoff = new Date(Date.parse(now) - REQUEST_DAYS * 86_400_000).toISOString();
    db.run("DELETE FROM requests WHERE ts < ? AND json_extract(reply, '$.kind') IS NULL", [cutoff]);
}

/**
 * One BEGIN IMMEDIATE: check the request id, decide, apply, keep the reply. `dryRun` stops after `decide` and
 * returns the changes it would write.
 */
export function transact(
    db: Database,
    command: WorkCommand,
    env: WriteEnv,
    options: {
        dryRun?: boolean;
        projectItems?: boolean;
        approvedLegacy?: LegacyAction[];
        writeLegacy?: (action: LegacyAction) => LegacyWriteResult;
    } = {}
): Reply<WriteOutcome> | { replay: Reply<unknown> } | { pending: PendingWrite; existing: boolean } {
    const principal = principalOf(env);
    db.run("BEGIN IMMEDIATE");

    try {
        if (env.request !== undefined) {
            const request = requestOf(db, principal, env.request);

            if (request !== null && "kind" in request) {
                db.run("ROLLBACK");
                return { pending: request, existing: true };
            }

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
            const preview = decision.changes.map((change, index) => {
                if (options.projectItems === true) {
                    applyChange(db, change);
                }

                return { ...change, seq: -(index + 1) };
            });
            const projected =
                options.projectItems === true
                    ? decision.items.map((id) => selectItem(db, id)).filter((item) => item !== null)
                    : undefined;
            db.run("ROLLBACK");
            return okReply(
                command.verb,
                {
                    items: decision.items,
                    changes: preview,
                    legacy: decision.legacy,
                    noop: decision.noop === true,
                    ...(projected !== undefined ? { projected } : {}),
                },
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
        const completedLegacy: PendingWrite["completed"] = [];
        if (options.writeLegacy !== undefined && decision.legacy.length > 0) {
            const beforeLegacy = journalHead(db);
            for (const action of decision.legacy) {
                const written = options.writeLegacy(action);
                if (!written.ok) {
                    db.run("ROLLBACK");
                    return failReply(
                        command.verb,
                        [
                            errorDiagnostic(
                                "LEGACY_REFUSED",
                                `Handoff action ${action.action} was refused: ${written.error ?? "no result"}.`
                            ),
                        ],
                        decision.next
                    );
                }
                completedLegacy.push({ action: action.action, ...written });
            }
            for (const change of selectChangesAfter(db, beforeLegacy, -1)) {
                applied.push(change);
            }
        }
        const reply = okReply(
            command.verb,
            {
                items: decision.items,
                changes: applied,
                legacy: decision.legacy,
                noop: decision.noop === true,
                ...(completedLegacy.length > 0 ? { completedLegacy } : {}),
            },
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
            const pending: PendingWrite = {
                kind: "work.pending",
                operationId: randomUUID(),
                outcome: reply,
                completed: completedLegacy,
            };
            storeReply(db, principal, env.request, pending, env.now);
            db.run("COMMIT");
            return { pending, existing: false };
        }

        db.run("COMMIT");
        return reply;
    } catch (error) {
        db.run("ROLLBACK");
        throw error;
    }
}
