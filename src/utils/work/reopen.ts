/**
 * A reopen is two transactions around one delivery: the reason and the move, then the message to the worker, then
 * a `delivered` change with the receipt. A delivery with an unknown outcome is never sent again: a repeat with the
 * same request id answers the stored reply.
 */
import { errorDiagnostic, failReply, type NextAction, okReply, type Reply } from "@genesiscz/utils/output/reply";
import type { Item, WorkerStamp } from "./model/item";
import type { DeliveryReceipt, SessionPlace } from "./ports";
import { workerOf } from "./read";
import { envOf, type WorkContext, write } from "./service";
import { selectItem } from "./store/rows";
import { principalOf, replayOf, storeReply } from "./store/transact";

export interface ReopenData {
    item: Item;
    worker: WorkerStamp | null;
    place: SessionPlace | null;
    receipt: DeliveryReceipt | null;
    key: string | null;
}

export interface ReopenInput {
    ref: string;
    why: string;
    request?: string;
    /** `never` reopens without a message to the worker. */
    deliver?: "auto" | "never";
    dryRun?: boolean;
}

export function reopenMessage(item: Item, why: string): string {
    return [
        `Reopened ${item.id} "${item.title}".`,
        `Why: ${why}`,
        `Read the item and its log (work show ${item.id}) before you go on, and finish it again with a new proof.`,
    ].join("\n");
}

function nobodyAliveNext(item: Item, worker: WorkerStamp | null, place: SessionPlace | null): NextAction[] {
    const who = worker ? `${worker.harness} session ${worker.sessionTitle ?? worker.sessionId ?? "?"}` : "nobody";
    const where = place ? ` (last place: ${place.label})` : "";
    return [
        { do: "resume the worker", ask: `Resume ${who}${where} and give it ${item.id}?` },
        { do: "hand it to another agent", call: { method: "handoff", params: { title: item.title, from: [item.id] } } },
        { do: "work it yourself", ask: `Should this session take ${item.id} itself?` },
    ];
}

export async function reopen(ctx: WorkContext, input: ReopenInput): Promise<Reply<ReopenData>> {
    if (input.request !== undefined) {
        const env = await envOf(ctx);
        const replay = replayOf(ctx.db, principalOf(env), `${input.request}#reopen`);

        if (replay !== null) {
            return replay as Reply<ReopenData>;
        }
    }

    const moved = await write(
        ctx,
        { verb: "reopen", ref: input.ref, why: input.why },
        { dryRun: input.dryRun, ...(input.request !== undefined ? { request: input.request } : {}) }
    );

    if (!moved.ok) {
        return failReply("reopen", moved.diagnostics, moved.next);
    }

    const itemId = moved.data.items[0]?.id;
    const item = itemId !== undefined ? selectItem(ctx.db, itemId) : null;

    if (item === null) {
        return failReply("reopen", [errorDiagnostic("NOT_FOUND", `No item ${input.ref} after the reopen.`)]);
    }

    const worker = workerOf(ctx.db, item.id);

    if (input.dryRun || input.deliver === "never") {
        return okReply(
            "reopen",
            { item, worker, place: null, receipt: null, key: null },
            { diagnostics: moved.diagnostics, ...(input.dryRun ? { dryRun: true } : {}) }
        );
    }

    const seq = moved.data.changes.at(-1);
    if (seq === undefined) {
        return okReply(
            "reopen",
            { item, worker, place: null, receipt: null, key: null },
            {
                diagnostics: moved.diagnostics,
            }
        );
    }

    const key = `work-reopen:${item.id}:${seq}`;
    const place = worker?.sessionId ? await ctx.ports.delivery.place(worker.sessionId, worker.harness) : null;
    const env = await envOf(ctx);
    const principal = principalOf(env);
    const attempt = input.request === undefined ? key : `${input.request}#reopen`;
    const prior = ctx.db
        .transaction(() => {
            const replay = replayOf(ctx.db, principal, attempt);
            if (replay !== null) {
                return replay as Reply<ReopenData>;
            }
            const unknown: DeliveryReceipt = { outcome: "unknown", to: worker, at: env.now };
            storeReply(
                ctx.db,
                principal,
                attempt,
                okReply("reopen", { item, worker, place, receipt: unknown, key }),
                env.now
            );
            return null;
        })
        .immediate();
    if (prior !== null) {
        return prior;
    }

    let receipt: DeliveryReceipt;

    if (worker === null || worker.sessionId === null || place?.live === false) {
        receipt = {
            outcome: "nobody-alive",
            to: worker,
            at: new Date().toISOString(),
            ...(place ? { target: place.label } : {}),
        };
    } else {
        receipt = await ctx.ports.delivery.deliver({
            sessionId: worker.sessionId,
            harness: worker.harness,
            text: reopenMessage(item, input.why),
            key,
        });
    }

    const logged = await write(ctx, { verb: "delivered", ref: item.id, key, receipt });
    const final = selectItem(ctx.db, item.id) ?? item;
    const next = receipt.outcome === "nobody-alive" ? nobodyAliveNext(final, worker, place) : [];
    const reply = okReply(
        "reopen",
        { item: final, worker, place, receipt, key },
        { diagnostics: [...moved.diagnostics, ...logged.diagnostics], next }
    );

    storeReply(ctx.db, principal, attempt, reply, env.now);

    return reply;
}
