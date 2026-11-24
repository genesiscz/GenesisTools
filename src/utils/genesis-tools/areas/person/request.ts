import { spawnToolDetached } from "@genesiscz/utils/cli/tools";
import {
    type ActionDef,
    type ActionOutcome,
    defineAction,
    type WayName,
} from "@genesiscz/utils/genesis-tools/actions/define";
import { APP_FACES, type AppFaceFlag } from "@genesiscz/utils/genesis-tools/capability/generated/app-surface";
import { refuseHostEffectInTest } from "@genesiscz/utils/test-process";
import { z } from "zod";
import { Delivery, type DeliveryName, deliverySchema, personConfigSchema } from "./deliveries";
import type { RequestJournal, RequestView } from "./journal";
import { requestActionLine, requestActionSchema, requestButtonLabelSchema } from "./request-actions";

/** One thing a request asks about, ticked on its own: what it is, the words it rests on, and a button to check it. */
export const requestRowSchema = z.object({
    id: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    /** The words the row rests on, shown quoted (what the person said, as an agent relayed it). */
    quote: z.string().max(2000).optional(),
    /** One more line under the title (where, when, who relayed it). */
    detail: z.string().max(500).optional(),
    action: requestActionSchema.optional(),
});

/** A request id: the journal stores it whole in the posted event and names the file by its digest. */
export const REQUEST_ID_PATTERN = /^[a-zA-Z0-9:._-]{1,500}$/;

export const noticeInputSchema = z.object({
    kind: z.literal("notice"),
    id: z.string().regex(REQUEST_ID_PATTERN),
    title: z.string().min(1).max(200),
    reason: z.string().min(1).max(20_000),
    /** The window a click on this request opens. */
    open: z
        .object({
            window: z.enum(Object.keys(APP_FACES) as AppFaceFlag[]),
            args: z.array(z.string().max(500)).max(20),
        })
        .optional(),
    /**
     * What the decision is about, as rows the window shows under the reason (Meeting, Time, Person); `help` is the
     * row's tooltip. Absent, the reason alone says it, as before these fields.
     */
    fields: z
        .array(
            z.object({
                label: z.string().trim().min(1).max(40),
                value: z.string().min(1).max(500),
                help: z.string().max(500).optional(),
            })
        )
        .max(12)
        .optional(),
    /** Extra buttons that keep the window open and answer nothing (play the clip it asks about, open a page). */
    actions: z.array(requestActionSchema).max(4).optional(),
    /** The words on the answering buttons: `confirm` answers done, `decline` answers declined. */
    buttons: z
        .object({ confirm: requestButtonLabelSchema.optional(), decline: requestButtonLabelSchema.optional() })
        .optional(),
    /**
     * The things one answer covers, each with its own tick (all ticked at first) and its own extra button (Play the
     * clip it is about). `confirm` answers done with the ids still ticked (`picked` on the outcome); with every row
     * unticked it cannot be pressed. A surface without ticks (the system dialog, a terminal) lists the rows, and its
     * confirm covers every row.
     */
    rows: z.array(requestRowSchema).min(1).max(40).optional(),
});
export type NoticeInput = z.infer<typeof noticeInputSchema>;
export type RequestRow = z.infer<typeof requestRowSchema>;

/**
 * The request as plain text, for a surface that shows no rows and no buttons (the system dialog, a terminal): the
 * reason, then each field as `Label: value`, then each action as the command or page a person can use instead.
 */
export function requestPlainText(request: Pick<NoticeInput, "reason" | "fields" | "actions" | "rows">): string {
    const fields = (request.fields ?? []).map((field) => `${field.label}: ${field.value}`);
    const actions = (request.actions ?? []).map((action) => requestActionLine(action));
    const rows = (request.rows ?? []).flatMap((row) => [
        `- ${row.title}${row.quote ? `: "${row.quote}"` : ""}`,
        ...(row.detail ? [`  ${row.detail}`] : []),
        ...(row.action ? [`  ${requestActionLine(row.action)}`] : []),
    ]);
    const covers = rows.length ? ["", "Confirming here covers every row above.", ...rows] : [];
    return [request.reason, ...(fields.length || actions.length ? ["", ...fields, ...actions] : []), ...covers].join(
        "\n"
    );
}

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
    /** A request with `rows` answered done in a window with ticks: the ids still ticked. Absent covers every row. */
    picked: z.array(z.string()).optional(),
});
export type RequestOutcome = z.infer<typeof requestOutcomeSchema>;
export const requestConfigSchema = z.object({ delivery: deliverySchema.default(Delivery.askNow) });

/** What an app window's answer needs besides the window itself: starting the app, and sending the answer back. */
export const WINDOW_REPLY_RESERVE_MS = 5_000;

/**
 * One deadline for a request window and the call that waits for it. The window counts its seconds from when it
 * arrives, after the app started, so it gets the caller's time less a reserve for that start and the reply: an answer
 * given before the deadline the window shows still reaches the caller.
 */
export function requestWindowDeadline(
    timeoutMs: number,
    deadlineSeconds: number | undefined
): { windowSeconds: number; callTimeoutMs: number } {
    const reserveMs = Math.min(WINDOW_REPLY_RESERVE_MS, Math.floor(timeoutMs / 4));
    const windowMs = Math.max(1, Math.min((deadlineSeconds ?? Number.POSITIVE_INFINITY) * 1000, timeoutMs - reserveMs));
    return { windowSeconds: windowMs / 1000, callTimeoutMs: Math.max(1, Math.min(timeoutMs, windowMs + reserveMs)) };
}

/**
 * A click consumes a pending request only after its target opens or the person answers the request window. One worker
 * at a time presents a request, and it reads the request's state again under that claim before any effect.
 */
export async function presentPostedRequest(options: {
    view: RequestView;
    journal: RequestJournal;
    openWindow?: (target: NonNullable<PersonRequest["open"]>) => Promise<ActionOutcome<unknown>>;
    showRequest: (request: PersonRequest) => Promise<RequestOutcome>;
}): Promise<RequestOutcome> {
    const { view, journal, openWindow, showRequest } = options;
    if (view.outcome.status !== "pending") {
        return view.outcome;
    }

    const claim = await journal.claim(view.id, async (current) => {
        if (openWindow && current.request.open) {
            const opened = await openWindow(current.request.open);
            if (opened.status === "ran") {
                return journal.settle(current.id, "done", null, { via: "notification", method: "click" });
            }

            const after = journal.get(current.id);
            if (after && after.outcome.status !== "pending") {
                return after.outcome;
            }
        }

        return showRequest(current.request);
    });
    if (claim.claimed) {
        return claim.value;
    }

    return claim.view.outcome.status === "pending"
        ? { ...claim.view.outcome, reason: "Another worker is presenting this request." }
        : claim.view.outcome;
}

/** Whether a surface took the request: a retry of the same id then waits instead of delivering it again. */
function wasDelivered(view: RequestView): boolean {
    return view.events.some((event) => event.type === "delivered");
}

/** The surface that took the request, from the way that ran and what it answered. */
function deliveredChannel(
    delivery: DeliveryName,
    ran: { via: WayName },
    value: RequestOutcome
): "dialog" | "notification" | "terminal" {
    if (value.via === "terminal") {
        return "terminal";
    }

    if (delivery === Delivery.notifyThenAsk || (delivery === Delivery.askElseNotify && ran.via !== "native")) {
        return "notification";
    }

    return "dialog";
}

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
            const answerOf = (outcome: RequestOutcome): RequestOutcome | Promise<RequestOutcome> =>
                outcome.status !== "pending" ||
                spec.wait === "posted" ||
                ctx.config.delivery === Delivery.notifyThenAsk ||
                ctx.facts.isAgent()
                    ? outcome
                    : journal.wait(posted.id, ctx.timeoutMs);
            if (posted.outcome.status !== "pending" || (!post.created && wasDelivered(posted))) {
                return answerOf(posted.outcome);
            }

            // A first post, or a retry of a post that no surface took yet.
            if (ctx.facts.isAgent() && ctx.config.delivery === Delivery.askNow) {
                refuseHostEffectInTest("request worker", "Inject a worker launcher in tests.");
                spawnToolDetached(["genesis-tools", "request", "run", "--", posted.id], { reparent: true });
                return {
                    id: posted.id,
                    status: "pending",
                    reason: "A detached worker is showing the request; the agent does not wait for a person.",
                };
            }

            const claim = await journal.claim(posted.id, async (current): Promise<RequestOutcome | null> => {
                if (wasDelivered(current)) {
                    return null;
                }

                const ran = await ctx.person[ctx.config.delivery](
                    {
                        ...current.request,
                        deadlineSeconds: ctx.timeoutMs / 1000,
                        takesFocus: personConfigSchema.parse(ctx.areaConfig).dialog.takesFocus,
                    },
                    // The nested delivery stops at this action's deadline or the caller's cancel.
                    { timeoutMs: ctx.timeoutMs, signal: ctx.signal }
                );
                if (ran.status !== "ran") {
                    return {
                        id: current.id,
                        status: "unreachable",
                        reason: ran.skipped.map((s) => s.reason).join("; "),
                    };
                }

                const value = ran.value;
                if (value.status === "unreachable") {
                    return value;
                }

                journal.append(current.id, {
                    type: "delivered",
                    at: new Date().toISOString(),
                    channel: deliveredChannel(ctx.config.delivery, ran, value),
                    noticeId: current.id,
                });
                if (value.status !== "pending") {
                    return journal.settle(current.id, value.status, value.reason, {
                        via: value.via,
                        method: value.method,
                        picked: value.picked,
                    });
                }

                return value;
            });
            if (!claim.claimed) {
                return answerOf(claim.view.outcome);
            }

            if (claim.value === null) {
                return answerOf(journal.get(posted.id)?.outcome ?? posted.outcome);
            }

            return claim.value.status === "unreachable" ? claim.value : answerOf(claim.value);
        },
    });
}
