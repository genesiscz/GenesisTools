import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { decisionFiles as defaultDecisionFiles } from "@app/question/lib/decisions/read";
import { reconcileQueuedDecision } from "@app/question/lib/decisions/store";
import {
    listSessionMessageOutcomes,
    type SessionMessage,
    type SessionMessageOutcome,
} from "@genesiscz/utils/agent-sessions/message-queue";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { LockTimeoutError, withFileLock } from "@genesiscz/utils/storage/file-lock";
import { mutateWidgetState, readWidgetState, widgetRoot } from "../widget/storage";
import { type WidgetAsset, type WidgetOutgoing, type WidgetState, widgetSessionKey } from "../widget/types";
import { messageReadiness, nextOutgoingByConversation } from "./outbox";
import { serializeWidgetMessage } from "./serialize";

export interface DispatchReceipt {
    channel: string;
    delivered: boolean;
    certainty?: "not-sent" | "unknown";
    detail?: string;
    entryId?: string;
    payloadHash?: string;
}
export interface OutboxDispatcher {
    /** `assets`: the message's attachments, resolved from the widget state it was serialized from. */
    validate(message: WidgetOutgoing, assets: WidgetAsset[]): Promise<void>;
    dispatch(message: WidgetOutgoing, text: string, assets: WidgetAsset[]): Promise<DispatchReceipt>;
}

function deliveryRevision(message: WidgetOutgoing, state: WidgetState): string {
    const assets = message.assetIds.map((id) => {
        const asset = state.assets[id];
        return asset?.type === "video"
            ? {
                  id,
                  sha256: asset.sha256,
                  path: asset.path,
                  revision: asset.revision,
                  settings: asset.settings,
                  confirmedRevision: asset.confirmedRevision,
                  manifestPath: asset.manifestPath,
              }
            : { id, sha256: asset?.sha256, path: asset?.path };
    });
    return createHash("sha256")
        .update(SafeJSON.stringify({ payload: message.payload, assets }))
        .digest("hex");
}

async function reconcileSessionQueue({
    root,
    queueRoot,
    decisions,
}: {
    root: string;
    queueRoot?: string;
    decisions: { file: string; events: string };
}): Promise<void> {
    const state = await readWidgetState(root);
    // One read per queue per run; an unreadable queue is skipped so the rest of the outbox keeps moving.
    // Outcomes include the receipts of messages the queue pruned, so a widget away for weeks still reconciles.
    const queues = new Map<string, SessionMessageOutcome[] | undefined>();
    const queueOf = (candidate: WidgetOutgoing, provider: SessionMessage["target"]["provider"]) => {
        const key = widgetSessionKey(candidate.target);
        if (!queues.has(key)) {
            try {
                queues.set(
                    key,
                    listSessionMessageOutcomes({ target: { ...candidate.target, provider }, root: queueRoot })
                );
            } catch (error) {
                logger.warn({ error, id: candidate.id, key }, "Widget could not read a session message queue");
                queues.set(key, undefined);
            }
        }

        return queues.get(key);
    };
    for (const candidate of state.outgoing) {
        if (
            !["waiting-route", "unknown"].includes(candidate.state) ||
            candidate.receipt?.channel !== "session-queue" ||
            !candidate.receipt.entryId ||
            candidate.target.provider === "unknown"
        ) {
            continue;
        }
        const queued = queueOf(candidate, candidate.target.provider)?.find(
            (entry) => entry.id === candidate.receipt?.entryId
        );
        if (!queued || !["received", "cancelled"].includes(queued.state)) {
            continue;
        }
        if (
            candidate.payload.kind === "decision" &&
            candidate.receipt.payloadHash === queued.textHash &&
            candidate.receipt.payloadRevision === deliveryRevision(candidate, state)
        ) {
            const matched = await reconcileQueuedDecision({
                ...decisions,
                id: candidate.payload.id,
                session: candidate.target.sessionId,
                revision: candidate.payload.expectedRevision,
                queueId: queued.id,
                received: queued.state === "received",
                consumer: queued.consumer,
            });
            if (!matched) {
                await updateOutgoing(root, candidate.id, (message) => {
                    message.state = "unknown";
                    message.error = "The decision changed before its queue acknowledgement; inspect the conversation.";
                });
                continue;
            }
        }
        await updateOutgoing(root, candidate.id, (message, current) => {
            if (
                !["waiting-route", "unknown"].includes(message.state) ||
                message.receipt?.entryId !== queued.id ||
                widgetSessionKey(message.target) !== widgetSessionKey(candidate.target)
            ) {
                return;
            }
            const exactPayload =
                message.receipt.payloadHash === queued.textHash &&
                message.receipt.payloadRevision === deliveryRevision(message, current);
            if (!exactPayload) {
                message.state = "unknown";
                message.error = "The queued payload changed; its acknowledgement cannot confirm this revision.";
                return;
            }
            message.state = queued.state === "received" ? "sent" : "cancelled";
            message.receipt.delivered = queued.state === "received";
            message.receipt.at = Date.parse(queued.updatedAt);
            message.receipt.detail =
                queued.state === "received"
                    ? `Received by ${queued.consumer}`
                    : "Cancelled before a consumer received it";
            delete message.error;
        });
    }
}

export async function processWidgetOutbox({
    root,
    dispatcher,
    signal,
    queueRoot,
    decisions = defaultDecisionFiles(),
}: {
    root?: string;
    dispatcher: OutboxDispatcher;
    signal?: AbortSignal;
    queueRoot?: string;
    decisions?: { file: string; events: string };
}): Promise<void> {
    signal?.throwIfAborted();
    const directory = widgetRoot(root);
    await reconcileSessionQueue({ root: directory, queueRoot, decisions });
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
                    const assets = first.assetIds.flatMap((id) => current.assets[id] ?? []);
                    try {
                        text = await serializeWidgetMessage(first, current);
                        await dispatcher.validate(first, assets);
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
                        const receipt = await dispatcher.dispatch(first, text, assets);
                        await updateOutgoing(directory, first.id, (message) => {
                            message.state = receipt.delivered
                                ? "sent"
                                : receipt.certainty === "not-sent"
                                  ? "waiting-route"
                                  : "unknown";
                            message.receipt = {
                                ...receipt,
                                at: Date.now(),
                                ...(receipt.channel === "session-queue"
                                    ? { payloadRevision: deliveryRevision(first, current) }
                                    : {}),
                            };
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
