import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import type { DeliverDeps } from "@app/question/lib/decisions/deliver";
import { decisionFiles } from "@app/question/lib/decisions/read";
import { sendAnsweredDecisions } from "@app/question/lib/decisions/send";
import type { HarvestedDecision } from "@app/question/lib/decisions/store";
import { answerInboxDecisions, type DecisionAnswer } from "@app/question/lib/inbox/answer";
import { dismissDecision, draftDecision, sendDrafts } from "@app/question/lib/inbox/drafts";
import { type InboxDeps, loadInbox, loadSessionDecisions, waitingBlock } from "@app/question/lib/inbox/load";

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
];

function refusal(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(err, CALLER_MISTAKES.some((pattern) => pattern.test(message)) ? 400 : 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** The same shape `tools question inbox answer --batch` takes: [{ number, option?, text? }]. */
function parseAnswers(value: unknown): DecisionAnswer[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const answers: DecisionAnswer[] = [];

    for (const entry of value) {
        if (!isRecord(entry) || typeof entry.number !== "number") {
            return null;
        }

        const option = optionalString(entry.option);
        const text = optionalString(entry.text);
        answers.push({ number: entry.number, ...(option ? { option } : {}), ...(text ? { text } : {}) });
    }

    return answers;
}

/**
 * The /qa Decisions tab's door onto the hub inbox: the same list (`loadInbox`, `loadSessionDecisions`),
 * the same answer-and-deliver (`answerInboxDecisions`) and the same re-send of queued answers
 * (`sendAnsweredDecisions`) that `tools question inbox` and `tools question send` use.
 */
export function qaDecisionRoutes(deps: QaDecisionDeps = {}): RouteDef[] {
    const files = deps.files ?? (() => decisionFiles());

    return [
        {
            method: "GET",
            pattern: "/api/qa/decisions",
            handler: async (ctx) => {
                const hours = Number.parseInt(ctx.query.get("hours") ?? "72", 10);

                try {
                    const result = await loadInbox({
                        hours: Number.isFinite(hours) && hours > 0 ? hours : 72,
                        ...(deps.inbox ? { deps: deps.inbox } : {}),
                    });

                    return { kind: "json", status: 200, body: result };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            // Every decision of one session, in every state (the hub's Decisions pane).
            method: "GET",
            pattern: "/api/qa/decisions/session/:id",
            handler: async (ctx) => {
                const session = ctx.params.id ?? "";

                try {
                    const decisions = await loadSessionDecisions(session, deps.session);
                    return { kind: "json", status: 200, body: { sessionId: session, decisions } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            // Answers several decisions and delivers them as ONE message, like `inbox answer --batch`.
            method: "POST",
            pattern: "/api/qa/decisions/answer",
            handler: async (ctx) => {
                const body = await ctx.readJson<unknown>().catch(() => null);
                const session = isRecord(body) ? optionalString(body.session) : undefined;
                const answers = isRecord(body) ? parseAnswers(body.answers) : null;

                if (!isRecord(body) || !session || !answers) {
                    return {
                        kind: "json",
                        status: 400,
                        body: { error: "expected { session, answers: [{ number, option?, text? }], dryRun? }" },
                    };
                }

                const provider = optionalString(body.provider);
                const cwd = optionalString(body.cwd);

                try {
                    const { file, events } = files();
                    const result = await answerInboxDecisions(
                        {
                            session,
                            answers,
                            ...(provider ? { provider } : {}),
                            ...(cwd ? { cwd } : {}),
                            dryRun: body.dryRun === true,
                        },
                        {
                            file,
                            events,
                            block: deps.block ?? waitingBlock,
                            ...(deps.deliver ? { deliver: deps.deliver } : {}),
                        }
                    );

                    return { kind: "json", status: 200, body: result };
                } catch (err) {
                    return refusal(err);
                }
            },
        },
        {
            // Re-sends answers that stayed queued (stored `answered`), like `tools question send`.
            method: "POST",
            pattern: "/api/qa/decisions/send",
            handler: async (ctx) => {
                const body = await ctx.readJson<unknown>().catch(() => null);
                const session = isRecord(body) ? optionalString(body.session)?.trim() : undefined;
                const provider = isRecord(body) ? optionalString(body.provider) : undefined;

                if (!session) {
                    return { kind: "json", status: 400, body: { error: "session required" } };
                }

                try {
                    const result = await sendAnsweredDecisions({
                        session,
                        ...(provider ? { provider } : {}),
                        files: files(),
                        deps: deps.deliver,
                    });
                    return { kind: "json", status: 200, body: result };
                } catch (err) {
                    return refusal(err);
                }
            },
        },
        {
            // Marks or clears one decision's pick and note; nothing is sent (the pick-then-send model).
            method: "POST",
            pattern: "/api/qa/decisions/draft",
            handler: async (ctx) => {
                const body = await ctx.readJson<unknown>().catch(() => null);
                const session = isRecord(body) ? optionalString(body.session)?.trim() : undefined;
                const number = isRecord(body) && typeof body.number === "number" ? body.number : undefined;

                if (!session || number === undefined) {
                    return {
                        kind: "json",
                        status: 400,
                        body: { error: "expected { session, number, option?, text? }" },
                    };
                }

                try {
                    const row = await draftDecision(
                        {
                            session,
                            number,
                            ...(isRecord(body) && typeof body.option === "string" ? { option: body.option } : {}),
                            ...(isRecord(body) && typeof body.text === "string" ? { text: body.text } : {}),
                            ...(isRecord(body) ? { provider: optionalString(body.provider) } : {}),
                            ...(isRecord(body) ? { cwd: optionalString(body.cwd) } : {}),
                        },
                        { ...files(), block: deps.block ?? waitingBlock }
                    );
                    return { kind: "json", status: 200, body: row };
                } catch (err) {
                    return refusal(err);
                }
            },
        },
        {
            // Drops a decision that no longer matters, without sending anything.
            method: "POST",
            pattern: "/api/qa/decisions/dismiss",
            handler: async (ctx) => {
                const body = await ctx.readJson<unknown>().catch(() => null);
                const session = isRecord(body) ? optionalString(body.session)?.trim() : undefined;
                const number = isRecord(body) && typeof body.number === "number" ? body.number : undefined;

                if (!session || number === undefined) {
                    return { kind: "json", status: 400, body: { error: "expected { session, number }" } };
                }

                try {
                    const row = await dismissDecision({ session, number }, files());
                    return { kind: "json", status: 200, body: row };
                } catch (err) {
                    return refusal(err);
                }
            },
        },
        {
            // Promotes every drafted answer of a session and delivers them as one message.
            method: "POST",
            pattern: "/api/qa/decisions/send-drafts",
            handler: async (ctx) => {
                const body = await ctx.readJson<unknown>().catch(() => null);
                const session = isRecord(body) ? optionalString(body.session)?.trim() : undefined;

                if (!session) {
                    return { kind: "json", status: 400, body: { error: "session required" } };
                }

                try {
                    const result = await sendDrafts(
                        {
                            session,
                            ...(isRecord(body) ? { provider: optionalString(body.provider) } : {}),
                            dryRun: isRecord(body) && body.dryRun === true,
                        },
                        {
                            ...files(),
                            block: deps.block ?? waitingBlock,
                            ...(deps.deliver ? { deliver: deps.deliver } : {}),
                        }
                    );
                    return { kind: "json", status: 200, body: result };
                } catch (err) {
                    return refusal(err);
                }
            },
        },
    ];
}
