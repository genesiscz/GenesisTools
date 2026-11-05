import {
    codexMessageDriver,
    KeyPressUnknownError,
    MessageError,
    NoChannelError,
    pressKeyInSurface,
} from "@app/ai/lib/agent-message/delivery";
import { sessionOpenDialog } from "@app/claude/lib/cmux/dialog-guard";
import { titleMatchKeys } from "@app/cmux/lib/title-match";
import { type DeliverDeps, type DeliveryResult, deliverToSession } from "@app/question/lib/decisions/deliver";
import { DeliveryUnknownError } from "@app/question/lib/decisions/delivery-errors";
import { enqueueSessionMessage, SessionMessageTooLargeError } from "@genesiscz/utils/agent-sessions/message-queue";
import { type FleetEntry, readFleetView } from "@genesiscz/utils/ai/live-sessions/fleet";
import { logger } from "@genesiscz/utils/logger";
import { sessionSourceHome } from "@genesiscz/utils/providers/session-paths";
import { boardKey } from "../board/phases";
import { senderOf } from "./registry";
import type {
    SendEdges,
    SendTiming,
    SessionAddress,
    SessionInterruptReceipt,
    SessionSendReceipt,
    SessionSendRequest,
} from "./types";

export { allSendTimings, SEND_TIMINGS, senderOf, sendTimingsOf } from "./registry";
export type * from "./types";

const log = logger.child({ component: "hub/send" });

// M5, one session-send module: every send into a running Claude, Codex or Grok session from the hub's doors (the
// phone's composer, Esc and nudge, the walkie-talkie, saved prompts) goes through `sendToSession` and
// `interruptSession`. Each harness says what each timing means in `senders/<id>.ts` (`registry.ts`). The transports
// are the existing ones: the decision answer-route ladder (`deliverToSession`: owned worker, the harness's structured
// route, the guarded cmux pane), the Codex daemon queue (`codex queue`), the durable session queue, and a guarded
// `cmux send-key`.

/** A `deliverToSession` result as a send receipt: delivered, saved in the durable queue, or refused. */
export function receiptOfDelivery(sent: DeliveryResult, timing: SendTiming): SessionSendReceipt {
    if (sent.delivered) {
        return { outcome: "delivered", timing, route: sent.channel, detail: sent.target ?? "delivered" };
    }

    if (sent.queueId) {
        return {
            outcome: "queued-session",
            timing,
            route: "session-queue",
            detail: sent.error ?? "saved for this exact session",
            queueId: sent.queueId,
        };
    }

    return { outcome: "refused", timing, route: sent.channel, detail: sent.error ?? "not delivered" };
}

function refused(timing: SendTiming, route: string, detail: string): SessionSendReceipt {
    return { outcome: "refused", timing, route, detail };
}

/** The real transports. `deliver` reaches the answer-route ladder's own edges (tests pass scripted ones). */
export function liveSendEdges(deliver: DeliverDeps = {}): SendEdges {
    return {
        async deliverNow(request) {
            try {
                const sent = await deliverToSession(
                    {
                        session: request.sessionId,
                        provider: request.provider,
                        sourceHome: request.sourceHome ?? undefined,
                        text: request.text,
                        deliveryKey: request.idempotencyKey,
                    },
                    deliver
                );
                return receiptOfDelivery(sent, request.timing);
            } catch (error) {
                if (error instanceof DeliveryUnknownError) {
                    return { outcome: "unknown", timing: request.timing, route: "unknown", detail: error.message };
                }

                throw error;
            }
        },
        async codexQueue(request) {
            try {
                const delivery = await codexMessageDriver({ resolveId: async () => request.sessionId }).deliver({
                    query: request.sessionId,
                    text: request.text,
                });
                return { outcome: "queued-daemon", timing: request.timing, route: delivery.via, detail: delivery.note };
            } catch (error) {
                if (error instanceof NoChannelError) {
                    return refused(request.timing, "codex-queue", error.message);
                }

                if (error instanceof MessageError) {
                    return { outcome: "unknown", timing: request.timing, route: "codex-queue", detail: error.message };
                }

                throw error;
            }
        },
        async enqueue(request) {
            if (!request.sourceHome) {
                return refused(
                    request.timing,
                    "session-queue",
                    "the session's home is unknown, so the durable queue cannot address it"
                );
            }

            try {
                const queued = await enqueueSessionMessage({
                    target: {
                        provider: request.provider,
                        sessionId: request.sessionId,
                        sourceHome: request.sourceHome,
                    },
                    text: request.text,
                    idempotencyKey: request.idempotencyKey,
                    root: deliver.queueRoot,
                });
                return {
                    outcome: "queued-session",
                    timing: request.timing,
                    route: "session-queue",
                    detail: "saved for this exact session; it is received when the session's consumer acknowledges it",
                    queueId: queued.id,
                };
            } catch (error) {
                if (error instanceof SessionMessageTooLargeError) {
                    return refused(request.timing, "session-queue", error.message);
                }

                throw error;
            }
        },
        async pressKey(address, key) {
            // A key in a pane that shows a question, plan or permission dialog answers the dialog: refuse instead.
            const dialog = await sessionOpenDialog({ sessionId: address.sessionId, provider: address.provider });

            if (dialog) {
                return {
                    outcome: "refused",
                    route: "cmux-key",
                    detail: `a ${dialog.kind} dialog is open in the session, and ${key} would dismiss it. Answer it first; nothing was pressed.`,
                };
            }

            try {
                const pressed = await pressKeyInSurface({ alias: address.provider, sessionId: address.sessionId, key });
                return { outcome: "sent", route: "cmux-key", detail: `${key} pressed in ${pressed.ref}` };
            } catch (error) {
                if (error instanceof KeyPressUnknownError) {
                    return { outcome: "unknown", route: "cmux-key", detail: error.message };
                }

                if (error instanceof MessageError) {
                    return { outcome: "refused", route: "cmux-key", detail: error.message };
                }

                throw error;
            }
        },
    };
}

/** Sends one message at the chosen timing through the session's harness sender; a timing it lacks is refused. */
export async function sendToSession(
    request: SessionSendRequest,
    edges: SendEdges = liveSendEdges()
): Promise<SessionSendReceipt> {
    if (!request.text.trim()) {
        return refused(request.timing, "none", "the message is empty");
    }

    const route = senderOf(request.provider).timings[request.timing];

    if ("refused" in route) {
        log.info({ provider: request.provider, timing: request.timing }, "send timing refused by the harness");
        return refused(request.timing, "none", route.refused);
    }

    const receipt = await route.send(request, edges);
    log.info(
        {
            provider: request.provider,
            sessionId: request.sessionId,
            timing: request.timing,
            outcome: receipt.outcome,
            route: receipt.route,
        },
        "session send settled"
    );
    return receipt;
}

/** Ends the session's running turn (its TUI's Esc key), after the pane and dialog guards. */
export async function interruptSession(
    address: SessionAddress,
    edges: SendEdges = liveSendEdges()
): Promise<SessionInterruptReceipt> {
    const interrupt = senderOf(address.provider).interrupt;

    if ("refused" in interrupt) {
        return { outcome: "refused", route: "none", detail: interrupt.refused };
    }

    const receipt = await edges.pressKey(address, interrupt.key);
    log.info(
        { provider: address.provider, sessionId: address.sessionId, outcome: receipt.outcome },
        "session interrupt settled"
    );
    return receipt;
}

/** The exact session behind a board key, located again now; or why it cannot be addressed. */
export function addressOfEntry(entry: FleetEntry): SessionAddress | { reason: string } {
    if (!entry.sessionId) {
        return { reason: "the session has no id yet, so nothing can be addressed to it" };
    }

    return {
        provider: entry.provider,
        sessionId: entry.sessionId,
        sourceHome: entry.transcript ? sessionSourceHome(entry.provider, entry.transcript.filePath) : null,
    };
}

export interface BoardSendDeps {
    fleet(): Promise<FleetEntry[]>;
    edges: SendEdges;
}

export function liveBoardSendDeps(): BoardSendDeps {
    return { fleet: () => readFleetView({ titleKeys: titleMatchKeys }), edges: liveSendEdges() };
}

async function locateBoardSession(key: string, deps: BoardSendDeps): Promise<SessionAddress | { reason: string }> {
    const entry = (await deps.fleet()).find((candidate) => boardKey(candidate) === key);
    return entry ? addressOfEntry(entry) : { reason: "the session is no longer live" };
}

/** The phone's send (F10): the board key is located again, then `sendToSession`. */
export async function sendToBoardSession(
    input: { key: string; text: string; timing: SendTiming; idempotencyKey?: string },
    deps: BoardSendDeps = liveBoardSendDeps()
): Promise<SessionSendReceipt & { key: string }> {
    const address = await locateBoardSession(input.key, deps);

    if ("reason" in address) {
        return { key: input.key, ...refused(input.timing, "none", address.reason) };
    }

    const receipt = await sendToSession(
        { ...address, text: input.text, timing: input.timing, idempotencyKey: input.idempotencyKey },
        deps.edges
    );
    return { key: input.key, ...receipt };
}

/** The phone's Esc (F19): the board key is located again, then `interruptSession`. */
export async function interruptBoardSession(
    input: { key: string },
    deps: BoardSendDeps = liveBoardSendDeps()
): Promise<SessionInterruptReceipt & { key: string }> {
    const address = await locateBoardSession(input.key, deps);

    if ("reason" in address) {
        return { key: input.key, outcome: "refused", route: "none", detail: address.reason };
    }

    return { key: input.key, ...(await interruptSession(address, deps.edges)) };
}
