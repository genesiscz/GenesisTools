import { decisionFiles as defaultDecisionFiles } from "@app/question/lib/decisions/read";
import { reconcileQueuedDecision } from "@app/question/lib/decisions/store";
import { cancelSessionMessage, listSessionMessages } from "@genesiscz/utils/agent-sessions/message-queue";
import { SafeJSON } from "@genesiscz/utils/json";
import { mutateWidgetState, readWidgetState } from "../widget/storage";
import {
    type WidgetOutgoing,
    type WidgetPayload,
    type WidgetState,
    type WidgetTarget,
    widgetOutgoingSchema,
    widgetSessionKey,
} from "../widget/types";

export function messageReadiness(message: WidgetOutgoing, state: WidgetState): WidgetOutgoing["state"] {
    for (const id of message.assetIds) {
        const asset = state.assets[id];
        if (!asset) {
            return "failed";
        }

        if (asset.type === "video") {
            if (asset.status === "failed") {
                return "failed";
            }

            if (asset.status !== "ready") {
                return "preparing";
            }

            if (asset.settings.minimumDifferencePct > 0 && asset.confirmedRevision !== asset.revision) {
                return "review";
            }
        }
    }
    return "queued";
}

export async function enqueueWidgetMessage({
    root,
    id,
    target,
    payload,
    assetIds = [],
    draftSnapshot,
}: {
    root?: string;
    id: string;
    target: WidgetTarget;
    payload: WidgetPayload;
    assetIds?: string[];
    draftSnapshot?: { text: string; assetIds: string[] };
}): Promise<WidgetOutgoing> {
    return mutateWidgetState(root, (state) => {
        const existing = state.outgoing.find((message) => message.id === id);
        if (existing) {
            if (
                widgetSessionKey(existing.target) !== widgetSessionKey(target) ||
                SafeJSON.stringify(existing.payload) !== SafeJSON.stringify(payload) ||
                SafeJSON.stringify(existing.assetIds) !== SafeJSON.stringify(assetIds)
            ) {
                throw new Error("This outgoing ID already belongs to a different message");
            }
            return existing;
        }

        if (
            payload.kind !== "form" &&
            !payload.text.trim() &&
            !assetIds.length &&
            !(payload.kind === "decision" && payload.option)
        ) {
            throw new Error("Write a message or attach media before sending");
        }

        for (const assetId of assetIds) {
            if (!state.assets[assetId]) {
                throw new Error("An attachment is missing; reattach it before sending");
            }
            if (state.outgoing.some((message) => message.state !== "cancelled" && message.assetIds.includes(assetId))) {
                throw new Error("Attach a fresh copy when reusing media in another message");
            }
        }
        const message = widgetOutgoingSchema.parse({
            id,
            target,
            payload,
            assetIds,
            createdAt: Date.now(),
            sequence: (state.outgoing.at(-1)?.sequence ?? 0) + 1,
            state: "queued",
        });
        message.state = messageReadiness(message, state);
        state.outgoing.push(message);
        const key = widgetSessionKey(target);
        const draft = state.drafts[key] ?? { text: "", assetIds: [] };
        const submittedText = draftSnapshot?.text ?? payload.text;
        state.drafts[key] = {
            text: draft.text === submittedText ? "" : draft.text,
            assetIds: draft.assetIds.filter((assetId) => !assetIds.includes(assetId)),
        };
        return message;
    });
}

export function nextOutgoingByConversation(state: WidgetState): WidgetOutgoing[] {
    const blocked = new Set<string>();
    const result: WidgetOutgoing[] = [];
    for (const message of [...state.outgoing].sort((a, b) => a.sequence - b.sequence)) {
        if (message.state === "sent" || message.state === "cancelled") {
            continue;
        }
        const key = widgetSessionKey(message.target);
        if (blocked.has(key)) {
            continue;
        }
        blocked.add(key);
        if (message.state === "queued") {
            result.push(message);
        }
    }
    return result;
}

export async function recoverWidgetOutbox(root?: string): Promise<void> {
    await mutateWidgetState(root, (state) => {
        for (const message of state.outgoing) {
            if (message.state === "dispatching") {
                message.state = "unknown";
                message.error = "The app closed while dispatching. Check the conversation before choosing a retry.";
            }
        }
        for (const asset of Object.values(state.assets)) {
            if (asset.type === "video" && asset.status === "preparing") {
                asset.status = "pending";
            }
        }
    });
}

export async function changeOutgoing({
    root,
    id,
    action,
    confirmedUnknown = false,
    queueRoot,
    decisions = defaultDecisionFiles(),
}: {
    root?: string;
    id: string;
    action: "retry" | "cancel" | "edit";
    confirmedUnknown?: boolean;
    queueRoot?: string;
    decisions?: { file: string; events: string };
}): Promise<void> {
    const before = await readWidgetState(root);
    const pending = before.outgoing.find((entry) => entry.id === id);
    // The queue entry this call cancelled; a watcher reconcile may mark the message cancelled before the edit lands.
    let cancelledEntry: string | undefined;
    if (
        pending?.receipt?.channel === "session-queue" &&
        pending.receipt.entryId &&
        pending.target.provider !== "unknown"
    ) {
        if (pending.state === "sent" || pending.state === "dispatching" || pending.state === "cancelled") {
            throw new Error("This message has already entered delivery or was cancelled.");
        }
        if (pending.state === "unknown" && !confirmedUnknown) {
            throw new Error("Delivery is unknown. Explicitly confirm after checking the conversation.");
        }
        const draft = before.drafts[widgetSessionKey(pending.target)];
        if (action === "edit" && (draft?.text || draft?.assetIds.length)) {
            throw new Error("Save or clear your current draft before editing an earlier message.");
        }
        const queueTarget = { ...pending.target, provider: pending.target.provider };
        const queued = listSessionMessages({ target: queueTarget, root: queueRoot }).find(
            (entry) => entry.id === pending.receipt?.entryId
        );
        if (!queued || queued.state === "offered" || queued.state === "received") {
            throw new Error(
                "This queued message may already have reached its consumer; wait for acknowledgement before editing, cancelling or retrying."
            );
        }
        if (action === "retry") {
            throw new Error(
                "This message is already saved for its exact destination; it will remain pending until a consumer acknowledges it."
            );
        }
        await cancelSessionMessage({ target: queueTarget, id: queued.id, root: queueRoot });
        cancelledEntry = queued.id;
        if (pending.payload.kind === "decision") {
            const matched = await reconcileQueuedDecision({
                ...decisions,
                id: pending.payload.id,
                session: pending.target.sessionId,
                revision: pending.payload.expectedRevision,
                queueId: queued.id,
                received: false,
            });
            if (!matched) {
                throw new Error("The decision changed while cancelling its queued answer; refresh before editing it.");
            }
        }
    }
    await mutateWidgetState(root, (state) => {
        const message = state.outgoing.find((entry) => entry.id === id);
        if (!message) {
            throw new Error("No such outgoing message");
        }
        if (message.state === "sent" || message.state === "dispatching") {
            throw new Error("This message has already entered delivery");
        }
        if (message.state === "unknown" && !confirmedUnknown) {
            throw new Error("Delivery is unknown. Explicitly confirm after checking the conversation.");
        }
        const cancelledHere = cancelledEntry !== undefined && message.receipt?.entryId === cancelledEntry;
        if (message.state === "cancelled" && !cancelledHere) {
            throw new Error("A cancelled message cannot be retried; submit a new message.");
        }
        if (action === "edit") {
            const key = widgetSessionKey(message.target);
            const draft = state.drafts[key];
            if (draft?.text || draft?.assetIds.length) {
                throw new Error("Save or clear your current draft before editing an earlier message.");
            }
            state.drafts[key] = {
                text: message.payload.text,
                assetIds: [...message.assetIds],
            };
            state.selectedKey = key;
            message.state = "cancelled";
        } else if (action === "cancel") {
            message.state = "cancelled";
        } else {
            message.state = messageReadiness(message, state);
            delete message.error;
        }
    });
}
