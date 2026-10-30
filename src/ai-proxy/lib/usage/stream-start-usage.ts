import { ClaudeCodeTurn } from "@app/ai-proxy/lib/translators/formats/anthropic/claude-code-turns";
import type { AnthropicUsage } from "@app/ai-proxy/lib/translators/formats/anthropic/openai-to-anthropic-responses";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { estimateTokens } from "@genesiscz/utils/tokens";

/**
 * The input count a translated stream reports in its Anthropic `message_start` frame.
 *
 * The real Anthropic API knows a request's input count when the stream opens, and Claude Code shows the usage of the
 * message it is streaming: its statusline input `context_window.current_usage` is that message's `message_start`
 * usage until `message_delta` replaces it. A Responses upstream (Codex, Grok) reports usage only in its final
 * `response.completed` frame, and a `message_start` with `input_tokens: 0` made the statusline of a Codex-backed
 * session drop to 0 at the start of every turn and come back when the turn ended (session 8cf9eff2, 2026-10-30:
 * 291,748, then 0, then 293,172 in three renders within 8 s).
 *
 * The best count before the upstream answers is the last real count of the same Claude Code thread: a conversation
 * only grows between two turns, by the size of the last reply and the tool results. A thread with no remembered count
 * (its first turn, or the first turn after a proxy restart) uses the request's own estimate, and so does a request
 * whose estimate is less than half the remembered count (a compaction or a cleared context shrank it).
 */

/** Claude Code threads remembered at once; the oldest is forgotten first. */
const CAPACITY = 512;

/** The input side of a usage block: its output count is not part of a context reading. */
function inputSide(usage: AnthropicUsage): AnthropicUsage {
    const out: AnthropicUsage = { input_tokens: usage.input_tokens, output_tokens: 0 };

    if (usage.cache_read_input_tokens !== undefined) {
        out.cache_read_input_tokens = usage.cache_read_input_tokens;
    }

    if (usage.cache_creation_input_tokens !== undefined) {
        out.cache_creation_input_tokens = usage.cache_creation_input_tokens;
    }

    return out;
}

/** Input plus cache reads plus cache writes: what the client adds up as its context. */
export function contextTokensOf(usage: AnthropicUsage): number {
    return usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

export class ThreadContextMemory {
    private readonly entries = new Map<string, AnthropicUsage>();

    constructor(private readonly capacity = CAPACITY) {}

    recall(key: string): AnthropicUsage | undefined {
        return this.entries.get(key);
    }

    /** Keeps the input side of a final usage block. A block that counts no input is not a reading and is ignored. */
    remember(key: string, usage: AnthropicUsage): void {
        if (contextTokensOf(usage) <= 0) {
            return;
        }

        this.entries.delete(key);
        this.entries.set(key, inputSide(usage));

        while (this.entries.size > this.capacity) {
            const oldest = this.entries.keys().next();

            if (oldest.done) {
                break;
            }

            this.entries.delete(oldest.value);
        }
    }

    /** The usage for the `message_start` of a new turn of the thread `key` (no key: the estimate alone). */
    startUsage(key: string | undefined, estimate: number): AnthropicUsage {
        const held = key === undefined ? undefined : this.recall(key);

        if (held === undefined || estimate * 2 < contextTokensOf(held)) {
            return { input_tokens: estimate, output_tokens: 0 };
        }

        return held;
    }
}

/** One memory for the whole proxy process: every provider that translates a Responses stream reads and feeds it. */
export const threadContextMemory = new ThreadContextMemory();

/**
 * The two stream options a provider passes to `responsesSseToAnthropic` for one request: the `message_start` usage
 * of its thread, and the hook that remembers the final usage for the next turn. `scope` separates clients (the
 * presented credential), the Claude Code thread key separates the main loop from each subagent.
 */
export function streamUsageOptions({
    scope,
    body,
    memory = threadContextMemory,
}: {
    scope: string;
    body: Record<string, unknown>;
    memory?: ThreadContextMemory;
}): { startUsage: AnthropicUsage; onUsage: (usage: AnthropicUsage) => void } {
    const thread = ClaudeCodeTurn.read(body).threadKey;
    const key = thread === undefined ? undefined : `${scope}\u0000${thread}`;

    const estimate = estimateAnthropicBodyTokens(body);
    const held = key === undefined ? undefined : memory.recall(key);
    const startUsage = memory.startUsage(key, estimate);
    logger.debug(
        {
            thread,
            estimate,
            held: held === undefined ? undefined : contextTokensOf(held),
            start: contextTokensOf(startUsage),
        },
        "ai-proxy: message_start usage of a translated stream"
    );

    return {
        startUsage,
        onUsage: (usage) => {
            if (key !== undefined) {
                memory.remember(key, usage);
            }
        },
    };
}

/** Characters-per-token estimate of an Anthropic request: its system prompt, messages and tool definitions. */
export function estimateAnthropicBodyTokens(body: Record<string, unknown>): number {
    const sink: string[] = [];
    collectText(body.system, sink);
    collectText(body.messages, sink);
    collectText(body.tools, sink);
    return estimateTokens(sink.join("\n"));
}

function collectText(value: unknown, sink: string[]): void {
    if (typeof value === "string") {
        sink.push(value);
        return;
    }

    if (Array.isArray(value)) {
        for (const entry of value) {
            collectText(entry, sink);
        }

        return;
    }

    if (isObject(value)) {
        for (const entry of Object.values(value)) {
            collectText(entry, sink);
        }
    }
}
