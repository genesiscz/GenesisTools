import { resolve } from "node:path";
import {
    type DeliverDeps,
    DeliveryUnknownError,
    deliverToSession,
    resolveDeliveryTarget,
} from "@app/question/lib/decisions/deliver";
import { decisionFiles } from "@app/question/lib/decisions/read";

import { kindOf, readDecisions } from "@app/question/lib/decisions/store";
import { answerInboxDecision } from "@app/question/lib/inbox/answer";
import { waitingBlock } from "@app/question/lib/inbox/load";
import { type AskDeps, answerAskForm, checkAskAnswer, getAskForm } from "@app/question/lib/pending/ask";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import type { WidgetOutgoing } from "../widget/types";
import type { OutboxDispatcher } from "./engine";

async function runWidgetDelivery({ args, signal }: { args: string[]; signal?: AbortSignal }) {
    const result = await boundedCommand({
        command: [process.execPath, resolve(import.meta.dir, "../../../../widget-tools"), ...args],
        timeoutMs: 60_000,
        signal,
    });
    if (result.error || result.status !== 0) {
        throw new DeliveryUnknownError(
            "The transport was attempted but returned no successful receipt. Check the conversation before retrying."
        );
    }
    if (args[0] === "claude") {
        let raw: unknown;
        try {
            raw = SafeJSON.parse(result.stdout, { strict: true });
        } catch (error) {
            logger.warn({ error }, "Widget transport receipt could not be decoded");
            throw new DeliveryUnknownError(
                "The transport returned no readable receipt. Check the conversation before retrying."
            );
        }
        if (typeof raw !== "object" || raw === null || !("sent" in raw) || typeof raw.sent !== "boolean") {
            throw new DeliveryUnknownError(
                "The transport returned an unreadable receipt. Check the conversation before retrying."
            );
        }
    }
    return { success: true, stdout: result.stdout, stderr: result.stderr };
}

export function widgetDispatcher({
    deliver: supplied,
    signal,
    files = decisionFiles(),
    ask = {},
}: {
    deliver?: DeliverDeps;
    signal?: AbortSignal;
    files?: { file: string; events: string };
    ask?: AskDeps;
} = {}): OutboxDispatcher {
    const deliver = supplied ?? { runTool: (args: string[]) => runWidgetDelivery({ args, signal }) };
    return {
        async validate(message) {
            const payload = message.payload;
            if (payload.kind === "decision") {
                const row = readDecisions(files.file).find((entry) => entry.id === payload.id);
                if (
                    !row ||
                    kindOf(row) !== "decision" ||
                    row.sessionId !== message.target.sessionId ||
                    row.number !== payload.number ||
                    (row.provider &&
                        row.provider !== message.target.provider &&
                        !(row.provider === "claude-code" && message.target.provider === "claude")) ||
                    (row.revision ?? 1) !== payload.expectedRevision ||
                    !["open", "drafted"].includes(row.state)
                ) {
                    throw new Error("The decision changed or belongs to another session; refresh it before answering.");
                }
            } else if (payload.kind === "form") {
                const form = getAskForm(payload.id, ask);
                if (form?.status !== "pending") {
                    throw new Error("This question was already resolved. Refresh the inbox before answering.");
                }
                if ((form.sessionHint || form.id) !== message.target.sessionId) {
                    throw new Error("This question belongs to another session.");
                }
                const checked = checkAskAnswer(payload.id, payload.answers, ask);
                if (!checked.ok) {
                    throw new Error(checked.error);
                }
            } else if (message.target.provider === "unknown") {
                throw new Error("Choose a specific destination session before sending this follow-up.");
            }
        },
        async dispatch(message: WidgetOutgoing, text: string) {
            const payload = message.payload;
            if (payload.kind === "form") {
                const existing = getAskForm(payload.id, ask);
                if (existing?.status !== "pending") {
                    return {
                        delivered: false,
                        certainty: "not-sent",
                        channel: "form",
                        detail: "Question was resolved elsewhere; your submitted answer was not recorded.",
                    };
                }
                const answers = payload.answers.map((answer, index) => ({
                    ...answer,
                    ...(index === 0 && text ? { mediaContext: text } : {}),
                }));
                const result = await answerAskForm(payload.id, answers, ask);
                if (!result.ok) {
                    return { delivered: false, certainty: "not-sent", channel: "form", detail: result.error };
                }
                return {
                    delivered: true,
                    channel: "form",
                    entryId: result.entryId,
                    detail: "Answer recorded for the waiting agent",
                };
            }
            if (payload.kind === "decision") {
                const row = readDecisions(files.file).find((entry) => entry.id === payload.id);
                if (row?.delivery?.uncertain) {
                    throw new DeliveryUnknownError(
                        "An earlier delivery of this decision is unresolved. Inspect the conversation in Hub."
                    );
                }
                if (!row || !["open", "drafted"].includes(row.state)) {
                    return {
                        delivered: false,
                        certainty: "not-sent",
                        channel: "decisions",
                        detail: "Decision changed elsewhere. Refresh it before answering.",
                    };
                }
                const route = await resolveDeliveryTarget(
                    { session: message.target.sessionId, provider: message.target.provider },
                    deliver
                );
                if (route.kind === "none") {
                    return { delivered: false, certainty: "not-sent", channel: "queued", detail: route.reason };
                }
                const sent = await answerInboxDecision(
                    {
                        session: message.target.sessionId,
                        provider: message.target.provider,
                        cwd: message.target.cwd,
                        number: payload.number,
                        expectedRevision: payload.expectedRevision,
                        option: payload.option,
                        text,
                    },
                    { ...files, block: waitingBlock, deliver }
                );
                return {
                    delivered: sent.delivered === true,
                    channel: sent.channel ?? "queued",
                    certainty: sent.delivered ? undefined : "not-sent",
                    detail: sent.target ?? sent.error ?? "Queued in Decisions for this session",
                };
            }
            const target = await resolveDeliveryTarget(
                { session: message.target.sessionId, provider: message.target.provider },
                deliver
            );
            if (target.kind === "none") {
                return { delivered: false, certainty: "not-sent", channel: "queued", detail: target.reason };
            }
            const sent = await deliverToSession(
                { session: message.target.sessionId, provider: message.target.provider, text },
                deliver
            );
            return {
                delivered: sent.delivered,
                channel: sent.channel,
                certainty: sent.delivered ? undefined : "not-sent",
                detail: sent.target ?? sent.error,
            };
        },
    };
}
