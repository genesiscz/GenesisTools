import { type AiProxySessionRecord, sessionTagId } from "@app/ai-proxy/lib/sessions/records";
import { readRequestTags } from "@app/ai-proxy/lib/usage/transcripts";
import type { RequestTags } from "@app/ai-proxy/lib/usage/types";

/** Headers a client uses to name its own conversation: codex-rs (`session-id`, `thread-id`), ai-proxy's older Codex
 * shape (`session_id`) and Grok (`x-grok-conv-id`). */
const CONVERSATION_HEADERS = ["session-id", "session_id", "thread-id", "x-grok-conv-id"] as const;

/**
 * The tags a request is booked under. A session key's requests carry the session's id, whatever header the client
 * sends. Any other client keeps its `x-gt-*` headers, and when it names no `x-gt-session`, the conversation id it
 * sent on its own (Claude Code's `metadata.user_id` session id, a body `prompt_cache_key`, or a conversation header)
 * becomes `tags.session`, so its calls and its transcript file line up with the client's own session.
 */
export function requestTagsFor(
    headers: Headers,
    session: AiProxySessionRecord | undefined,
    conversationId: string | undefined
): RequestTags | undefined {
    const tags = readRequestTags(headers);

    if (session) {
        return { ...tags, session: sessionTagId(session) };
    }

    if (tags?.session) {
        return tags;
    }

    const own = conversationId ?? conversationIdFromHeaders(headers);
    return own ? { ...tags, session: own } : tags;
}

function conversationIdFromHeaders(headers: Headers): string | undefined {
    for (const name of CONVERSATION_HEADERS) {
        const value = headers.get(name)?.trim();

        if (value) {
            return value;
        }
    }

    return undefined;
}
