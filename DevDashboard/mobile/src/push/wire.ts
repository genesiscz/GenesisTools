import { PUSH_DATA_KEY, type PushData } from "@dd/contract";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `gt` block of a push, from wherever iOS put the payload: a remote alert's trigger, or a background task's data. */
export function pushDataOf(source: unknown): PushData | null {
    if (!isRecord(source)) {
        return null;
    }

    const block = source[PUSH_DATA_KEY];

    if (!isRecord(block) || block.v !== 1) {
        return null;
    }

    if (block.kind === "notice" || (block.kind === "retract" && Array.isArray(block.noticeIds))) {
        return block as unknown as PushData;
    }

    return null;
}

/** The `gt` block of a delivered notification: a remote push keeps its whole payload on the trigger. */
export function noticeDataOf(notification: {
    request: { trigger: unknown; content: { data?: unknown } };
}): PushData | null {
    const trigger = notification.request.trigger;
    const payload = isRecord(trigger) ? trigger.payload : undefined;
    return pushDataOf(payload) ?? pushDataOf(notification.request.content.data);
}
