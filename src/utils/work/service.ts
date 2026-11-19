import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { errorDiagnostic, failReply, okReply, type Reply } from "@genesiscz/utils/output/reply";
import type { ContextStamp } from "./model/change";
import type { Actor, Item } from "./model/item";
import type {
    ConnectorPort,
    LegacyAction,
    LegacyHandoffs,
    LegacyWriteResult,
    LineageResolver,
    SessionDelivery,
} from "./ports";
import type { ResolvedRules } from "./rules/resolve";
import type { WorkCommand, WriteEnv } from "./store/decide";
import { newItemId } from "./store/decide";
import { selectItem } from "./store/rows";
import {
    type PendingWrite,
    principalOf,
    replayOf,
    requestOf,
    storeReply,
    transact,
    type WriteOutcome,
} from "./store/transact";

export interface WorkPorts {
    legacy: LegacyHandoffs;
    delivery: SessionDelivery;
    lineage?: LineageResolver;
    /** The connectors (P5); a door without them answers the connector methods with CONNECTORS_MISSING. */
    connectors?: ConnectorPort;
}

export interface WorkContext {
    db: Database;
    actor: Actor;
    project: string;
    ports: WorkPorts;
    now?: () => string;
    random?: () => string;
    stamp?: ContextStamp;
    /** A strong inferred handoff of the preflight context (P4); `spot` uses it only when no claim names one. */
    inferred?: { during: string; evidence: string };
    /** The effective rules of the project (P3). */
    rules?: ResolvedRules;
    /** The owner's words when an agent acts on them; the journal keeps them in the stamp. */
    ownerSaid?: string;
}

export interface WriteData {
    items: Item[];
    changes: number[];
    legacy?: (LegacyWriteResult & { action: LegacyAction["action"] })[];
    /** The id of a handoff that `handoff --from` posted. */
    handoff?: string;
    noop?: boolean;
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function randomItemSuffix(): string {
    const bytes = randomBytes(8);
    let out = "";

    for (const byte of bytes) {
        out += ID_ALPHABET[byte % ID_ALPHABET.length];
    }

    return out;
}

async function lineageOf(ctx: WorkContext): Promise<string[]> {
    const own = ctx.actor.sessionId !== null ? [ctx.actor.sessionId] : [];
    const parentThreadId = ctx.actor.host?.parentThreadId ?? null;

    if (ctx.ports.lineage === undefined || (parentThreadId === null && ctx.actor.sessionId === null)) {
        return own;
    }

    const leads = await ctx.ports.lineage.leadSessions({ sessionId: ctx.actor.sessionId, parentThreadId });
    return [...own, ...leads.filter((s) => !own.includes(s))];
}

function stampWithOwner(ctx: WorkContext): ContextStamp | undefined {
    if (ctx.ownerSaid === undefined) {
        return ctx.stamp;
    }

    const said = { path: "owner-said", value: ctx.ownerSaid, method: "given" as const, source: "--owner-said" };
    return { facts: [...(ctx.stamp?.facts ?? []), said] };
}

export async function envOf(ctx: WorkContext, request?: string): Promise<WriteEnv> {
    const now = ctx.now ?? (() => new Date().toISOString());
    const random = ctx.random ?? randomItemSuffix;
    return {
        actor: ctx.actor,
        now: now(),
        project: ctx.project,
        newId: () => newItemId(random),
        lineage: await lineageOf(ctx),
        ...(request !== undefined ? { request } : {}),
        ...(stampWithOwner(ctx) !== undefined ? { stamp: stampWithOwner(ctx) } : {}),
        ...(ctx.inferred !== undefined ? { inferred: ctx.inferred } : {}),
        ...(ctx.rules !== undefined ? { rules: ctx.rules } : {}),
    };
}

/**
 * One write: the old log's verdict on its part (folded in memory), the store's transaction, then the writes the old
 * log still owns. Their hook brings the result
 * back into the store, so the reply reads the rows again at the end.
 */
export async function write(
    ctx: WorkContext,
    command: WorkCommand,
    options: { request?: string; dryRun?: boolean } = {}
): Promise<Reply<WriteData>> {
    const env = await envOf(ctx, options.dryRun ? undefined : options.request);
    // The old log may refuse what the store accepts (a poster credential, a claim). During the double writing a
    // write it would refuse must not reach the store, so its actions are checked on a dry run before the commit.
    // The check folds in memory; it cannot run inside the store's transaction, because the old executor opens the
    // same database itself.
    const preview = transact(ctx.db, command, env, { dryRun: true, projectItems: options.dryRun === true });

    if (!("replay" in preview) && !("pending" in preview) && preview.ok && preview.data.legacy.length > 0) {
        const answers = await ctx.ports.legacy.check(preview.data.legacy);
        const refused = preview.data.legacy.flatMap((action, index) => {
            const answer = answers[index];

            return answer?.ok
                ? []
                : [
                      errorDiagnostic(
                          "LEGACY_REFUSED",
                          `The old handoff store would refuse ${action.action}: ${answer?.error ?? "no result"}. Nothing was written.`
                      ),
                  ];
        });

        if (refused.length > 0) {
            return failReply(command.verb, refused, preview.next);
        }
    }

    const result =
        options.dryRun || "replay" in preview || "pending" in preview || !preview.ok
            ? preview
            : transact(ctx.db, command, env, { approvedLegacy: preview.data.legacy });

    if ("replay" in result) {
        return result.replay as Reply<WriteData>;
    }

    if ("pending" in result) {
        return completeRequest(ctx, env, result.pending, result.existing);
    }

    if (!result.ok) {
        return failReply(result.verb, result.diagnostics, result.next);
    }

    if (options.dryRun) {
        return okReply(
            command.verb,
            {
                items: result.data.projected ?? [],
                changes: [],
                ...(result.data.legacy.length > 0
                    ? { legacy: result.data.legacy.map((a) => ({ action: a.action, ok: true })) }
                    : {}),
                noop: result.data.noop,
            },
            { diagnostics: result.diagnostics, next: result.next, dryRun: true }
        );
    }

    return finishWrite({ ctx, result, completed: [] });
}

type WriteSuccess = Extract<Reply<WriteOutcome>, { ok: true }>;
type LegacyResult = NonNullable<WriteData["legacy"]>[number];
const REQUEST_LEASE_MS = 120_000;

async function completeRequest(
    ctx: WorkContext,
    env: WriteEnv,
    pending: PendingWrite,
    existing: boolean
): Promise<Reply<WriteData>> {
    const request = env.request;
    const principal = principalOf(env);

    if (request === undefined || !pending.outcome.ok) {
        throw new Error("Cannot complete an invalid pending Work request.");
    }

    const token = randomUUID();
    const claim = ctx.db
        .transaction(() => {
            const current = requestOf(ctx.db, principal, request);

            if (current === null || !("kind" in current) || current.operationId !== pending.operationId) {
                return { claimed: false as const };
            }

            if (current.lease !== undefined && current.lease.until > Date.now()) {
                return { claimed: false as const };
            }

            const claimed = { ...current, lease: { token, until: Date.now() + REQUEST_LEASE_MS } };
            storeReply(ctx.db, principal, request, claimed, env.now);
            return { claimed: true as const, row: claimed };
        })
        .immediate();

    if (!claim.claimed) {
        const replay = replayOf(ctx.db, principal, request);

        if (replay !== null) {
            return replay as Reply<WriteData>;
        }

        return {
            ...failReply(pending.outcome.verb, [
                errorDiagnostic("REQUEST_IN_PROGRESS", "Retry this request with the same ID."),
            ]),
            receipt: pending.outcome.receipt,
        };
    }

    const row = claim.row;
    const save = (value: Reply<WriteData> | PendingWrite) =>
        ctx.db
            .transaction(() => {
                const current = requestOf(ctx.db, principal, request);

                if (current !== null && "kind" in current && current.lease?.token === token) {
                    storeReply(ctx.db, principal, request, value, env.now);
                }
            })
            .immediate();

    try {
        const reply = await finishWrite({
            ctx,
            result: pending.outcome,
            completed: row.completed,
            operationId: row.operationId,
            checkpoint: () => save({ ...row, lease: { token, until: Date.now() + REQUEST_LEASE_MS } }),
        });

        if (reply.ok) {
            save(reply);
            return existing && reply.receipt !== undefined
                ? { ...reply, receipt: { ...reply.receipt, replayed: true } }
                : reply;
        }

        return reply;
    } finally {
        save({ kind: row.kind, operationId: row.operationId, outcome: row.outcome, completed: row.completed });
    }
}

async function finishWrite({
    ctx,
    result,
    completed,
    operationId,
    checkpoint,
}: {
    ctx: WorkContext;
    result: WriteSuccess;
    completed: LegacyResult[];
    operationId?: string;
    checkpoint?: () => void;
}): Promise<Reply<WriteData>> {
    const { data: outcome } = result;

    for (let index = completed.length; index < outcome.legacy.length; index++) {
        const action = outcome.legacy[index];
        let written: LegacyWriteResult;

        try {
            written = await ctx.ports.legacy.write(
                action,
                operationId !== undefined ? `${operationId}:${index}` : undefined
            );
        } catch (error) {
            written = { ok: false, error: String(error) };
        }

        if (!written.ok) {
            return {
                ...failReply(
                    result.verb,
                    [
                        ...result.diagnostics,
                        errorDiagnostic(
                            "LEGACY_WRITE_FAILED",
                            `The old handoff store refused ${action.action}: ${written.error ?? "no reason"}. Committed Work changes are in the receipt.`
                        ),
                    ],
                    result.next
                ),
                ...(result.receipt !== undefined ? { receipt: result.receipt } : {}),
            };
        }

        completed.push({ action: action.action, ...written });
        checkpoint?.();
    }

    const handoff = completed.find((action) => action.action === "post")?.handoff;
    return okReply(
        result.verb,
        {
            items: outcome.items.map((id) => selectItem(ctx.db, id)).filter((item) => item !== null),
            changes: outcome.changes.map((c) => c.seq),
            ...(completed.length > 0 ? { legacy: completed } : {}),
            ...(handoff !== undefined ? { handoff } : {}),
            ...(outcome.noop ? { noop: true } : {}),
        },
        {
            diagnostics: result.diagnostics,
            next: result.next,
            ...(result.receipt !== undefined ? { receipt: result.receipt } : {}),
        }
    );
}
