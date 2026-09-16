import { watchFileFeed } from "@genesiscz/utils/fs/file-feed-watcher";
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

    // The reply is appended to the feed by another process, so this waits on the file changing.
    // It used to re-read and re-parse the WHOLE feed every 20 ms: on a 2000-event feed that was
    // 44 reads a second and 26 MB/s of parsing, for the entire timeout, which defaults to 300 s.
    let reply: MessageEvent | undefined;
    const lookUp = async (): Promise<{ done: boolean }> => {
        const events = await readFeedSince(paths, request.seq);
        reply = events.find(
            (event): event is MessageEvent =>
                event.type === "message" &&
                event.in_reply_to === request.message_id &&
                event.to_agent_ids.includes(request.from_agent_id)
        );

        return { done: reply !== undefined };
    };

    if (!(await lookUp()).done) {
        await watchFileFeed({
            path: paths.feedPath,
            onChange: lookUp,
            deadlineAt: Date.now() + options.timeoutMs,
        });
    }

    if (reply) {
        return reply;
    }

    throw new Error(`agents request ${request.message_id} timed out after ${options.timeoutMs}ms`);
}
