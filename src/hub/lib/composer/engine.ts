import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { LockTimeoutError, withFileLock } from "@genesiscz/utils/storage/file-lock";
import { mutateWidgetState, readWidgetState, widgetRoot } from "../widget/storage";
import { type WidgetOutgoing, type WidgetState, widgetSessionKey } from "../widget/types";
import { messageReadiness, nextOutgoingByConversation } from "./outbox";
import { serializeWidgetMessage } from "./serialize";

export interface DispatchReceipt {
    channel: string;
    delivered: boolean;
    certainty?: "not-sent" | "unknown";
    detail?: string;
    entryId?: string;
}
export interface OutboxDispatcher {
    validate(message: WidgetOutgoing): Promise<void>;
    dispatch(message: WidgetOutgoing, text: string): Promise<DispatchReceipt>;
}

export async function processWidgetOutbox({
    root,
    dispatcher,
    signal,
}: {
    root?: string;
    dispatcher: OutboxDispatcher;
    signal?: AbortSignal;
}): Promise<void> {
    signal?.throwIfAborted();
    const directory = widgetRoot(root);
    const state = await readWidgetState(directory);
    if (!state.outgoing.some((message) => ["preparing", "review", "queued"].includes(message.state))) {
        return;
    }

    await mutateWidgetState(directory, (current) => {
        for (const message of current.outgoing) {
            if (["preparing", "review", "queued"].includes(message.state)) {
                message.state = messageReadiness(message, current);
            }
        }
    });
    const ready = nextOutgoingByConversation(await readWidgetState(directory));
    await Promise.all(
        ready.map(async (candidate) => {
            const lane = Bun.hash(widgetSessionKey(candidate.target)).toString(16);
            await withFileLock(
                join(directory, `send-${lane}.lock`),
                async () => {
                    signal?.throwIfAborted();
                    const current = await readWidgetState(directory);
                    const first = nextOutgoingByConversation(current).find(
                        (message) => widgetSessionKey(message.target) === widgetSessionKey(candidate.target)
                    );
                    if (first?.id !== candidate.id) {
                        return;
                    }

                    let text: string;
                    const assetsBefore = SafeJSON.stringify(first.assetIds.map((id) => current.assets[id]));
                    try {
                        text = await serializeWidgetMessage(first, current);
                        await dispatcher.validate(first);
                    } catch (error) {
                        // A shutdown during the checks is not a verdict on the message: it stays queued.
                        if (signal?.aborted) {
                            return;
                        }

                        await updateOutgoing(directory, first.id, (message) => {
                            if (message.state === "queued") {
                                message.state = "failed";
                                message.error = error instanceof Error ? error.message : String(error);
                            }
                        });
                        return;
                    }
                    // Checked again at the claim itself, the last point where nothing has been attempted: a cancel
                    // that arrived during the checks leaves the message queued instead of marked dispatching.
                    const claimed = await mutateWidgetState(directory, (latest) => {
                        const message = latest.outgoing.find((entry) => entry.id === first.id);
                        if (
                            signal?.aborted ||
                            message?.state !== "queued" ||
                            messageReadiness(message, latest) !== "queued" ||
                            SafeJSON.stringify(message.assetIds.map((id) => latest.assets[id])) !== assetsBefore
                        ) {
                            return false;
                        }
                        message.state = "dispatching";
                        message.dispatchedAt = Date.now();
                        return true;
                    });
                    if (!claimed) {
                        return;
                    }

                    try {
                        const receipt = await dispatcher.dispatch(first, text);
                        await updateOutgoing(directory, first.id, (message) => {
                            message.state = receipt.delivered
                                ? "sent"
                                : receipt.certainty === "not-sent"
                                  ? "waiting-route"
                                  : "unknown";
                            message.receipt = { ...receipt, at: Date.now() };
                            message.error = receipt.delivered ? undefined : receipt.detail;
                        });
                    } catch (error) {
                        await updateOutgoing(directory, first.id, (message) => {
                            message.state = "unknown";
                            message.error = error instanceof Error ? error.message : String(error);
                        });
                        logger.warn(
                            { id: first.id, error },
                            "Widget delivery outcome is unknown; automatic retry disabled"
                        );
                    }
                },
                3000
            ).catch((error) => {
                if (!(error instanceof LockTimeoutError)) {
                    throw error;
                }
                logger.debug({ error, id: candidate.id }, "Another widget worker owns this conversation");
            });
        })
    );
}

export async function updateOutgoing(
    root: string,
    id: string,
    update: (message: WidgetOutgoing, state: WidgetState) => void
): Promise<void> {
    await mutateWidgetState(root, (state) => {
        const message = state.outgoing.find((entry) => entry.id === id);
        if (message) {
            update(message, state);
        }
    });
}

export function newOutgoingId(): string {
    return randomUUID();
}
