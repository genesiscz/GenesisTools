import { deriveRegistry } from "./derived-registry";
import { readFeedSince, withFeedLock } from "./feed";
import { ensureSessionDir, sessionPaths } from "./paths";
import { resolveMany, resolveOne } from "./resolve-token";
import type { MessageEvent } from "./types";

export async function sendRequest(options: {
    session: string;
    from: string;
    to: string;
    body: string;
    timeoutMs: number;
    meta?: Record<string, unknown>;
}): Promise<MessageEvent> {
    const paths = sessionPaths(options.session);
    ensureSessionDir(paths);

    const request = await withFeedLock(paths, ({ events, appendMessageEvent }) => {
        const registry = deriveRegistry(events);
        const sender = resolveOne(registry, options.from, "sender");
        const recipients = resolveMany(registry, options.to, "recipient");
        if (recipients.length !== 1) {
            throw new Error("agents request requires exactly one recipient");
        }

        return appendMessageEvent({
            type: "message",
            from_agent_id: sender.agent_id,
            from_agent_name: sender.agent_name,
            to_agent_ids: recipients,
            body: options.body,
            meta: { ...options.meta, request: true },
            private: false,
        });
    });

    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
        const events = await readFeedSince(paths, request.seq);
        const reply = events.find(
            (event): event is MessageEvent =>
                event.type === "message" &&
                event.in_reply_to === request.message_id &&
                event.to_agent_ids.includes(request.from_agent_id)
        );
        if (reply) {
            return reply;
        }

        await Bun.sleep(20);
    }

    throw new Error(`agents request ${request.message_id} timed out after ${options.timeoutMs}ms`);
}
