import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
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
import { principalOf, storeReply, transact } from "./store/transact";

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
        ...(ctx.ownerSaid !== undefined ? { ownerSaid: ctx.ownerSaid } : {}),
    };
}

/**
 * One write: the store's transaction first, then the writes the old log still owns. Their hook brings the result
 * back into the store, so the reply reads the rows again at the end.
 */
export async function write(
    ctx: WorkContext,
    command: WorkCommand,
    options: { request?: string; dryRun?: boolean } = {}
): Promise<Reply<WriteData>> {
    const env = await envOf(ctx, options.request);
    const result = transact(ctx.db, command, env, { dryRun: options.dryRun });

    if ("replay" in result) {
        return result.replay as Reply<WriteData>;
    }

    if (!result.ok) {
        return failReply(result.verb, result.diagnostics, result.next);
    }

    const outcome = result.data;
    const diagnostics = [...result.diagnostics];
    const legacyResults: WriteData["legacy"] = [];
    let handoff: string | undefined;

    if (options.dryRun) {
        return okReply(
            command.verb,
            {
                items: outcome.items.map((id) => selectItem(ctx.db, id)).filter((i): i is Item => i !== null),
                changes: [],
                ...(outcome.legacy.length > 0
                    ? { legacy: outcome.legacy.map((a) => ({ action: a.action, ok: true })) }
                    : {}),
                noop: outcome.noop,
            },
            { diagnostics, next: result.next, dryRun: true }
        );
    }

    for (const action of outcome.legacy) {
        const written = await ctx.ports.legacy.write(action);
        legacyResults.push({ action: action.action, ...written });

        if (!written.ok) {
            diagnostics.push(
                errorDiagnostic(
                    "LEGACY_WRITE_FAILED",
                    `The old handoff store refused ${action.action}: ${written.error ?? "no reason"}`
                )
            );
        }

        if (action.action === "post" && written.handoff !== undefined) {
            handoff = written.handoff;
        }
    }

    const failed = legacyResults.some((r) => !r.ok);
    const data: WriteData = {
        items: outcome.items.map((id) => selectItem(ctx.db, id)).filter((i): i is Item => i !== null),
        changes: outcome.changes.map((c) => c.seq),
        ...(legacyResults.length > 0 ? { legacy: legacyResults } : {}),
        ...(handoff !== undefined ? { handoff } : {}),
        ...(outcome.noop ? { noop: true } : {}),
    };
    const reply: Reply<WriteData> = failed
        ? failReply(command.verb, diagnostics, result.next)
        : okReply(command.verb, data, {
              diagnostics,
              next: result.next,
              ...(result.receipt ? { receipt: result.receipt } : {}),
          });

    if (options.request !== undefined) {
        storeReply(ctx.db, principalOf(env), options.request, reply, env.now);
    }

    return reply;
}
