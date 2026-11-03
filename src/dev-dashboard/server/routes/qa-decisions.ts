import { ENDPOINTS } from "@app/dev-dashboard/contract/endpoint-table";
import { bindEndpoint } from "@app/dev-dashboard/server/bind";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import type { DeliverDeps } from "@app/question/lib/decisions/deliver";
import { decisionFiles } from "@app/question/lib/decisions/read";
import { sendAnsweredDecisions } from "@app/question/lib/decisions/send";
import type { HarvestedDecision } from "@app/question/lib/decisions/store";
import { answerInboxDecisions } from "@app/question/lib/inbox/answer";
import { dismissDecision, draftDecision, sendDrafts } from "@app/question/lib/inbox/drafts";
import {
    type InboxDeps,
    loadInbox,
    loadSessionDecisions,
    loadWaitingQueue,
    waitingBlock,
} from "@app/question/lib/inbox/load";
import { z } from "zod";

export interface QaDecisionDeps {
    /** The decision log and its events feed. Tests point this at a scratch store. */
    files?: () => { file: string; events: string };
    /** The inbox's session, transcript and cache readers. Tests pass fakes. */
    inbox?: InboxDeps;
    /** One session's decisions: the stored rows and the last reply's scan. Tests pass fakes. */
    session?: Parameters<typeof loadSessionDecisions>[1];
    /** The `❓ DECISION N` block of a session's last reply, for a decision the store does not have yet. */
    block?: (session: string, number: number) => Promise<HarvestedDecision | null>;
    /** The delivery runner. Tests pass a fake, so a send can never type into a real pane. */
    deliver?: DeliverDeps;
}

/** The lib's refusals of a caller mistake. Anything else (a crashed delivery, a torn file) is a 500. */
const CALLER_MISTAKES = [
    /^nothing to send$/,
    /^no answers to send$/,
    /^the option is one letter/,
    /^DECISION \d+: pass an option letter/,
    /^DECISION \d+ is not waiting/,
    /^DECISION \d+ has options/,
    /^DECISION \d+ is already/,
    /^DECISION \d+ changed: the agent posted a new text/,
];

function refusal(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(err, CALLER_MISTAKES.some((pattern) => pattern.test(message)) ? 400 : 500);
}

/** A text the caller may leave blank: a blank one reads as absent, as before the table. */
const optionalText = z
    .unknown()
    .optional()
    .transform((value) => (typeof value === "string" && value.trim().length > 0 ? value : undefined));
/** A session id: required, trimmed. */
const session = z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1));
/** The revision the caller showed; a newer post refuses the write. */
const revision = z.number().int().positive().optional();

/** The same shape `tools question inbox answer --batch` takes: [{ number, option?, text?, expectedRevision? }]. */
const answers = z.array(
    z.object({ number: z.number(), option: optionalText, text: optionalText, expectedRevision: revision })
);

/** Drops the keys a transform left undefined, so the lib sees the same objects as before the table. */
function defined<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * The /qa Decisions tab's door onto the hub inbox: the same list (`loadInbox`, `loadSessionDecisions`),
 * the same answer-and-deliver (`answerInboxDecisions`) and the same re-send of queued answers
 * (`sendAnsweredDecisions`) that `tools question inbox` and `tools question send` use. Every route is bound from its
 * endpoint table row (`contract/endpoint-table.ts`); a write with an `Idempotency-Key` returns its first answer on a
 * retry, and the draft and dismiss writes take the revision the caller showed.
 */
export function qaDecisionRoutes(deps: QaDecisionDeps = {}): RouteDef[] {
    const files = deps.files ?? (() => decisionFiles());

    return [
        bindEndpoint(ENDPOINTS.qaDecisions, {
            input: z.object({ hours: z.unknown().optional() }).transform(({ hours }) => {
                const parsed = Number.parseInt(typeof hours === "string" ? hours : "72", 10);
                return { hours: Number.isFinite(parsed) && parsed > 0 ? parsed : 72 };
            }),
            invalid: "expected ?hours=N",
            run: ({ hours }) => loadInbox({ hours: hours ?? 72, ...(deps.inbox ? { deps: deps.inbox } : {}) }),
        }),
        // The phone's answer queue: the waiting set's items and counts, so the phone number equals the notch.
        bindEndpoint(ENDPOINTS.qaWaiting, {
            input: z.object({ hours: z.unknown().optional() }).transform(({ hours }) => {
                const parsed = Number.parseInt(typeof hours === "string" ? hours : "72", 10);
                return { hours: Number.isFinite(parsed) && parsed > 0 ? parsed : 72 };
            }),
            invalid: "expected ?hours=N",
            run: ({ hours }) => loadWaitingQueue({ hours: hours ?? 72, ...(deps.inbox ? { deps: deps.inbox } : {}) }),
        }),
        // Every decision of one session, in every state (the hub's Decisions pane).
        bindEndpoint(ENDPOINTS.qaDecisionsSession, {
            input: z.object({ id: z.string() }),
            invalid: "expected /api/qa/decisions/session/:id",
            run: async ({ id }) => ({ sessionId: id, decisions: await loadSessionDecisions(id, deps.session) }),
        }),
        // Answers several decisions and delivers them as ONE message, like `inbox answer --batch`.
        bindEndpoint(ENDPOINTS.qaDecisionsAnswer, {
            input: z
                .object({
                    session,
                    answers,
                    provider: optionalText,
                    cwd: optionalText,
                    dryRun: z.unknown().optional(),
                })
                .transform((body) =>
                    defined({
                        session: body.session,
                        answers: body.answers.map((answer) => defined(answer)),
                        provider: body.provider,
                        cwd: body.cwd,
                        dryRun: body.dryRun === true,
                    })
                ),
            invalid: "expected { session, answers: [{ number, option?, text? }], dryRun? }",
            error: refusal,
            run: (input) => {
                const { file, events } = files();
                return answerInboxDecisions(input, {
                    file,
                    events,
                    block: deps.block ?? waitingBlock,
                    ...(deps.deliver ? { deliver: deps.deliver } : {}),
                });
            },
        }),
        // Re-sends answers that stayed queued (stored `answered`), like `tools question send`.
        bindEndpoint(ENDPOINTS.qaDecisionsSend, {
            input: z
                .object({ session, provider: optionalText })
                .transform((body) => defined({ session: body.session, provider: body.provider })),
            invalid: "session required",
            error: refusal,
            run: (input) => sendAnsweredDecisions({ ...input, files: files(), deps: deps.deliver }),
        }),
        // Marks or clears one decision's pick and note; nothing is sent (the pick-then-send model).
        bindEndpoint(ENDPOINTS.qaDecisionsDraft, {
            input: z
                .object({
                    session,
                    number: z.number(),
                    option: z.unknown().optional(),
                    text: z.unknown().optional(),
                    provider: optionalText,
                    cwd: optionalText,
                    expectedRevision: revision,
                })
                .transform((body) =>
                    defined({
                        session: body.session,
                        number: body.number,
                        option: typeof body.option === "string" ? body.option : undefined,
                        text: typeof body.text === "string" ? body.text : undefined,
                        provider: body.provider,
                        cwd: body.cwd,
                        expectedRevision: body.expectedRevision,
                    })
                ),
            invalid: "expected { session, number, option?, text?, expectedRevision? }",
            error: refusal,
            run: (input) => draftDecision(input, { ...files(), block: deps.block ?? waitingBlock }),
        }),
        // Drops a decision that no longer matters, without sending anything.
        bindEndpoint(ENDPOINTS.qaDecisionsDismiss, {
            input: z
                .object({ session, number: z.number(), expectedRevision: revision })
                .transform((body) => defined(body)),
            invalid: "expected { session, number, expectedRevision? }",
            error: refusal,
            run: (input) => dismissDecision(input, files()),
        }),
        // Promotes every drafted answer of a session and delivers them as one message.
        bindEndpoint(ENDPOINTS.qaDecisionsSendDrafts, {
            input: z
                .object({ session, provider: optionalText, dryRun: z.unknown().optional() })
                .transform((body) =>
                    defined({ session: body.session, provider: body.provider, dryRun: body.dryRun === true })
                ),
            invalid: "session required",
            error: refusal,
            run: (input) =>
                sendDrafts(input, {
                    ...files(),
                    block: deps.block ?? waitingBlock,
                    ...(deps.deliver ? { deliver: deps.deliver } : {}),
                }),
        }),
    ];
}
