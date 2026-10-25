import { createHash } from "node:crypto";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

/**
 * One stable cache key per conversation, for every agent that routes the prompt cache by a key.
 *
 * Measured 2026-10-25 on the ChatGPT backend (gpt-6.1-sol, a 7,280-token prefix, three requests per arm): a fixed
 * session HEADER gave cache hits on 11 of 12 warm requests, a fixed `prompt_cache_key` with a random or absent header
 * gave 0 of 12. So the Codex agent sends the key as the body key AND as its session headers. codex-rs uses its own
 * session id for both (openai/codex 970111f6 `core/src/client.rs` 658-688). xAI takes the same value as the body
 * key and the `x-grok-conv-id` header.
 *
 * Policies:
 * - `claude-session` (default): Claude Code's own session id from Anthropic `metadata.user_id`, so the key, the
 *   ai-proxy session tag and Claude Code's transcript name are one id. It survives `--resume`.
 * - `content`: a UUID-shaped sha256 of model, system prompt and first message (switcheroo's formula,
 *   `tools/switcheroo/src/proxy/translate-request.ts` 148-154 in henderson-tech/pultik). Each subagent gets its own
 *   key; a changed system prompt makes a new one.
 * - `record`: the session record id (the fallback when the body names no session).
 */
export type PromptCacheKeyPolicy = "claude-session" | "content" | "record";

export const PROMPT_CACHE_KEY_POLICIES: readonly PromptCacheKeyPolicy[] = ["claude-session", "content", "record"];

export type PromptCacheKeySource = "client" | "claude-session" | "record" | "content";

export interface PromptCacheKey {
    key: string;
    source: PromptCacheKeySource;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_SESSION = /session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * Claude Code's session id from an Anthropic request's `metadata.user_id`. Claude Code 2.1.x sends a JSON string with
 * `session_id` (litellm reads it the same way); older builds sent `user_<hash>_account_<uuid>_session_<uuid>`.
 * Verified 2026-10-25 on 2.1.296: equal to the `session_id` that `claude -p --output-format json` prints, before
 * and after `--resume`.
 */
export function claudeSessionIdFromMetadata(metadata: unknown): string | undefined {
    const userId = isObject(metadata) ? metadata.user_id : undefined;

    if (typeof userId !== "string" || userId.length === 0) {
        return undefined;
    }

    if (userId.startsWith("{")) {
        try {
            const parsed = SafeJSON.parse(userId, { strict: true });

            if (isObject(parsed) && typeof parsed.session_id === "string" && parsed.session_id.length > 0) {
                return parsed.session_id;
            }
        } catch (err) {
            logger.debug({ err }, "prompt-cache-key: metadata.user_id is not JSON; trying the older string form");
        }
    }

    return userId.match(LEGACY_SESSION)?.[1];
}

/** A sha256 of the parts, shaped like a UUID (what codex-rs sends as its key). */
export function uuidFromHash(parts: unknown[]): string {
    const hash = createHash("sha256")
        .update(SafeJSON.stringify(parts, { strict: true }))
        .digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/** A key the upstream accepts: a UUID as is, anything else mapped to a UUID-shaped hash of itself. */
export function asCacheKey(value: string): string {
    return UUID.test(value) ? value.toLowerCase() : uuidFromHash([value]);
}

/**
 * Pick the key. A key the client sent itself always wins (a native Codex CLI or an SDK that manages its own cache),
 * so the proxy forwards it unchanged. Otherwise the policy decides; a policy whose input is missing falls back to
 * the next one in the order claude-session, record, content.
 */
export function resolvePromptCacheKey({
    policy = "claude-session",
    clientKey,
    claudeSessionId,
    recordId,
    content,
}: {
    policy?: PromptCacheKeyPolicy;
    clientKey?: string;
    claudeSessionId?: string;
    recordId?: string;
    /** Model, system prompt, first message: the `content` policy's inputs. */
    content?: { model: string; system: unknown; first: unknown };
}): PromptCacheKey | undefined {
    if (clientKey && clientKey.trim().length > 0) {
        return { key: clientKey.trim(), source: "client" };
    }

    const contentKey = (): PromptCacheKey | undefined =>
        content
            ? { key: uuidFromHash([content.model, content.system ?? "", content.first ?? ""]), source: "content" }
            : undefined;
    const sessionKey = (): PromptCacheKey | undefined =>
        claudeSessionId ? { key: asCacheKey(claudeSessionId), source: "claude-session" } : undefined;
    const recordKey = (): PromptCacheKey | undefined =>
        recordId ? { key: asCacheKey(recordId), source: "record" } : undefined;

    if (policy === "content") {
        return contentKey() ?? sessionKey() ?? recordKey();
    }

    if (policy === "record") {
        return recordKey() ?? sessionKey() ?? contentKey();
    }

    return sessionKey() ?? recordKey() ?? contentKey();
}
