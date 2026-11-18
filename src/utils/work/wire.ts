/**
 * The result shapes of the read methods, as schemas, so the actions registry's `work` area and the generated Swift
 * client (work-items P7, P8) carry types and not a bare JSON value. The types in `read.ts` and `handlers.ts` stay the
 * source of the code; `wire.test.ts` parses real results with these schemas, so the two cannot drift apart unseen.
 */
import { z } from "zod";
import { ITEM_STATES, ITEM_TYPES, SEVERITIES } from "./model/vocab";

const state = z.enum(ITEM_STATES);
const type = z.enum(ITEM_TYPES);

export const itemRowSchema = z.object({
    ref: z.string(),
    state,
    type,
    severity: z.enum(SEVERITIES).optional(),
    worker: z.string().optional(),
    title: z.string(),
    project: z.string(),
    slot: z.string().optional(),
});

/** A list row; with `fields` the caller picks columns, so each one is optional on the wire. */
export const listRowSchema = itemRowSchema.partial();

export const treeResultSchema = z.object({
    project: z.string(),
    containers: z.array(
        z.object({
            ref: z.string(),
            type,
            state,
            title: z.string(),
            open: z.number().int(),
            total: z.number().int(),
            members: z.array(itemRowSchema),
        })
    ),
    spotted: z.number().int(),
});

export const nextActionSchema = z.object({
    do: z.string(),
    call: z.object({ method: z.string(), params: z.record(z.string(), z.unknown()) }).optional(),
    ask: z.string().optional(),
});

export const triageRowSchema = z.object({
    ref: z.string(),
    group: z.enum(["spotted", "reopened-no-worker", "active-worker-gone", "spotted-in-finished"]),
    type,
    state,
    title: z.string(),
    where: z.string().optional(),
    why: z.string().optional(),
    userSees: z.string().optional(),
    severity: z.enum(SEVERITIES).optional(),
    spottedIn: z.object({ ref: z.string(), title: z.string(), state }).optional(),
    spottedBy: z.string().optional(),
    worker: z.string().optional(),
    next: z.array(nextActionSchema),
});

/** The reply envelope every door returns (`Reply<T>` in `src/utils/output/reply.ts`). */
export function replySchemaOf(data: z.ZodType) {
    return z.object({
        v: z.literal(1),
        verb: z.string(),
        ok: z.boolean(),
        data: data.optional(),
        diagnostics: z.array(
            z.object({
                code: z.string(),
                severity: z.enum(["error", "warning", "info"]),
                message: z.string(),
                field: z.string().optional(),
            })
        ),
        next: z.array(nextActionSchema),
        dryRun: z.literal(true).optional(),
        receipt: z
            .object({ requestId: z.string().optional(), changes: z.array(z.number()), replayed: z.boolean() })
            .optional(),
    });
}
