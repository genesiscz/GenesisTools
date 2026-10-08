import { SafeJSON } from "@genesiscz/utils/json";
import { mutateWidgetState } from "../widget/storage";
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
        const submittedText = draftSnapshot?.text ?? (payload.kind === "form" ? draft.text : payload.text);
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
}: {
    root?: string;
    id: string;
    action: "retry" | "cancel" | "edit";
    confirmedUnknown?: boolean;
}): Promise<void> {
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
        if (message.state === "cancelled") {
            throw new Error("A cancelled message cannot be retried; submit a new message.");
        }
        if (action === "edit") {
            const key = widgetSessionKey(message.target);
            const draft = state.drafts[key];
            if (draft?.text || draft?.assetIds.length) {
                throw new Error("Save or clear your current draft before editing an earlier message.");
            }
            state.drafts[key] = {
                text: message.payload.kind === "form" ? "" : message.payload.text,
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
