import { spawnToolDetached } from "@genesiscz/utils/cli/tools";
import { type ActionDef, defineAction } from "@genesiscz/utils/genesis-tools/actions/define";
import { APP_FACES, type AppFaceFlag } from "@genesiscz/utils/genesis-tools/capability/generated/app-surface";
import { refuseHostEffectInTest } from "@genesiscz/utils/test-process";
import { z } from "zod";
import { Delivery, type DeliveryName, deliverySchema, personConfigSchema } from "./deliveries";

export const noticeInputSchema = z.object({
    kind: z.literal("notice"),
    id: z.string().regex(/^[a-zA-Z0-9:._-]{1,500}$/),
    title: z.string().min(1).max(200),
    reason: z.string().min(1).max(20_000),
    /** The window a click on this request opens. */
    open: z
        .object({
            window: z.enum(Object.keys(APP_FACES) as AppFaceFlag[]),
            args: z.array(z.string().max(500)).max(20),
        })
        .optional(),
});
export type NoticeInput = z.infer<typeof noticeInputSchema>;

export const requestSchema = noticeInputSchema.extend({
    createdAt: z.string().datetime(),
    deadlineSeconds: z.number().positive().optional(),
    takesFocus: z.boolean().optional(),
});
export type PersonRequest = z.infer<typeof requestSchema>;

export const requestStatusSchema = z.enum(["done", "failed", "declined", "obsolete", "pending", "unreachable"]);
export const requestOutcomeSchema = z.object({
    id: z.string(),
    status: requestStatusSchema,
    reason: z.string().nullable(),
    method: z.enum(["click", "terminal", "touch-id", "password"]).optional(),
    via: z.string().optional(),
    elevation: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    exitCode: z.number().int().nullable().optional(),
    outputTail: z.string().optional(),
    verified: z.boolean().nullable().optional(),
    manual: z.string().optional(),
});
export type RequestOutcome = z.infer<typeof requestOutcomeSchema>;
export const requestConfigSchema = z.object({ delivery: deliverySchema.default(Delivery.askNow) });

/** A preset owns the request text and default delivery; callers only supply the preset's typed args. */
export function defineRequest<TArgs extends z.ZodType>(spec: {
    summary: string;
    args: TArgs;
    delivery: DeliveryName;
    wait: "settled" | "posted";
    build: (args: z.output<TArgs>) => NoticeInput;
}): ActionDef<TArgs, typeof requestOutcomeSchema, typeof requestConfigSchema> {
    return defineAction({
        onTimeout: (args) => ({
            id: spec.build(args).id,
            status: "pending",
            reason: "The caller's deadline passed; the request stays open.",
        }),
        summary: spec.summary,
        args: spec.args,
        result: requestOutcomeSchema,
        config: z.object({ delivery: deliverySchema.default(spec.delivery) }),
        native: async (ctx) => {
            if (ctx.facts.isTest()) {
                return ctx.pass("in-test: a test process never posts a person request");
            }
            const { createRequestJournal } = await import("./journal");
            const journal = ctx.service?.journal ?? createRequestJournal();
            const post = await journal.postOnce({ input: spec.build(ctx.args), timeoutMs: ctx.timeoutMs });
            const posted = post.view;
            if (!post.created) {
                return posted.outcome.status !== "pending" ||
                    spec.wait === "posted" ||
                    ctx.config.delivery === Delivery.notifyThenAsk ||
                    ctx.facts.isAgent()
                    ? posted.outcome
                    : journal.wait(posted.id, ctx.timeoutMs);
            }
            if (posted.outcome.status !== "pending") {
                return posted.outcome;
            }
            if (ctx.facts.isAgent() && ctx.config.delivery === Delivery.askNow) {
                refuseHostEffectInTest("request worker", "Inject a worker launcher in tests.");
                spawnToolDetached(["genesis-tools", "request", "run", posted.id], { reparent: true });
                return {
                    id: posted.id,
                    status: "pending",
                    reason: "A detached worker is showing the request; the agent does not wait for a person.",
                };
            }
            journal.append(posted.id, {
                type: "delivered",
                at: new Date().toISOString(),
                channel:
                    ctx.config.delivery === Delivery.notifyThenAsk ||
                    (ctx.config.delivery === Delivery.askElseNotify && (ctx.facts.isAgent() || !ctx.facts.hasDisplay()))
                        ? "notification"
                        : "dialog",
                noticeId: posted.id,
            });
            const outcome = await ctx.person[ctx.config.delivery](
                {
                    ...posted.request,
                    deadlineSeconds: ctx.timeoutMs / 1000,
                    takesFocus: personConfigSchema.parse(ctx.areaConfig).dialog.takesFocus,
                },
                { timeoutMs: ctx.timeoutMs }
            );
            const value: RequestOutcome =
                outcome.status === "ran"
                    ? outcome.value
                    : {
                          id: posted.request.id,
                          status: "unreachable",
                          reason: outcome.skipped.map((s) => s.reason).join("; "),
                      };
            if (value.status === "unreachable") {
                return value;
            }
            if (value.status !== "pending") {
                return journal.settle(posted.request.id, value.status, value.reason, {
                    via: value.via,
                    method: value.method,
                });
            }
            return spec.wait === "posted" || ctx.config.delivery === Delivery.notifyThenAsk || ctx.facts.isAgent()
                ? value
                : journal.wait(posted.request.id, ctx.timeoutMs);
        },
    });
}
