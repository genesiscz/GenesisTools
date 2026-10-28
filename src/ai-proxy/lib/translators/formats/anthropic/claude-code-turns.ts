import { createHash } from "node:crypto";
import { claudeSessionIdFromMetadata } from "@genesiscz/utils/ai/prompt-cache-key";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

/** Request shapes Claude Code sends that the proxy treats on their own: the compaction turn and the model probe. */

/**
 * How Claude Code's compaction prompt opens. It keeps the agent's tools in the request (cache reuse) and forbids them
 * in words only. Present in the Claude Code 2.1.296 binary (checked 2026-10-25); switcheroo keys on the same text.
 */
export const CLAUDE_CODE_COMPACTION_MARK = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.";

function textOf(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .map((block) => (isObject(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
        .join("\n");
}

/**
 * Where Claude Code's compaction prompt sits: the last user message, with only `system` messages after it. Claude
 * Code 2.1.312 sends a `role:system` token-budget note after the prompt (captured 2026-10-27), so the prompt is no
 * longer the last message. -1 when the request is not a compaction turn.
 */
function compactionPromptIndex(messages: unknown[]): number {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];

        if (isObject(message) && message.role === "system") {
            continue;
        }

        return isObject(message) &&
            message.role === "user" &&
            textOf(message.content).includes(CLAUDE_CODE_COMPACTION_MARK)
            ? index
            : -1;
    }

    return -1;
}

function messagesOf(body: { messages?: unknown }): unknown[] {
    return Array.isArray(body.messages) ? body.messages : [];
}

/**
 * How Claude Code 2.1.311+ opens the paragraph it appends when it asks for the summary again, because the last reply
 * had no `<summary>` tag (bundle and mock-server test, 2026-10-27). Seeing it means the earlier answer was wasted.
 */
export const CLAUDE_CODE_COMPACTION_RETRY_MARK = "For this reply only";

/**
 * A Claude Code thread: its session and the text of its system prompt, so the main loop and each subagent are their
 * own thread. Only the text counts: the compaction turn marks the system blocks for the cache differently than a
 * normal turn does (`ttl: "1h"` on one and not the other, 2026-10-28), and hashing the marks split one thread in two.
 */
export function claudeCodeThreadKey(claudeSessionId: string, system: unknown): string {
    const text =
        typeof system === "string"
            ? system
            : Array.isArray(system)
              ? system.map((block) => (isObject(block) && typeof block.text === "string" ? block.text : "")).join("\n")
              : "";
    return `${claudeSessionId}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

export type ClaudeCodeTurnKind = "compaction" | "probe" | "normal";

/**
 * One Claude Code request, read once: what kind of turn it is, which thread it belongs to, and the two rewrites a
 * compaction turn gets. Every rule about Claude Code's request shapes lives here, per version: both compaction bugs of
 * 2026-10-27 came from callers that each read the raw body with their own rule.
 */
export class ClaudeCodeTurn {
    private constructor(
        readonly body: Record<string, unknown>,
        private readonly messages: unknown[],
        private readonly promptIndex: number
    ) {}

    static read(body: Record<string, unknown>): ClaudeCodeTurn {
        const messages = messagesOf(body);
        return new ClaudeCodeTurn(body, messages, compactionPromptIndex(messages));
    }

    get kind(): ClaudeCodeTurnKind {
        return this.isCompaction ? "compaction" : this.isModelProbe ? "probe" : "normal";
    }

    /** Its last user message, with only system messages after it, carries the compaction prompt. */
    get isCompaction(): boolean {
        return this.promptIndex >= 0;
    }

    /** The compaction turn is Claude Code's second ask: the earlier reply had no summary it could use. */
    get isCompactionRetry(): boolean {
        const prompt = this.messages[this.promptIndex];
        return isObject(prompt) && textOf(prompt.content).includes(CLAUDE_CODE_COMPACTION_RETRY_MARK);
    }

    /**
     * The compaction prompt sits in a user text block of the last three messages, but the request is not a compaction
     * turn: a detection gap (Claude Code 2.1.312 put a system message after the prompt, and every compaction fell back
     * to the slow written summary unnoticed, 2026-10-27). Tool results are not read, so a quoted prompt is not counted.
     */
    get missedCompaction(): boolean {
        return (
            !this.isCompaction &&
            this.messages
                .slice(-3)
                .some(
                    (message) =>
                        isObject(message) &&
                        message.role === "user" &&
                        textOf(message.content).includes(CLAUDE_CODE_COMPACTION_MARK)
                )
        );
    }

    /**
     * Claude Code's `model_validation` probe: one user "Hi" at `max_tokens: 1`, sent once when `/model` or `--model`
     * names an id it does not know (Claude Code 2.1.296 binary, checked 2026-10-25). It throws on any error, and gives
     * up after 15 s with no retry.
     */
    get isModelProbe(): boolean {
        const [only] = this.messages;

        return (
            this.body.max_tokens === 1 &&
            this.messages.length === 1 &&
            this.body.tools === undefined &&
            isObject(only) &&
            only.role === "user" &&
            textOf(only.content) === "Hi"
        );
    }

    get sessionId(): string | undefined {
        return claudeSessionIdFromMetadata(this.body.metadata);
    }

    /** Claude Code's `/effort`, sent as `output_config.effort`. */
    get effort(): string | undefined {
        const config = this.body.output_config;
        const effort = isObject(config) && typeof config.effort === "string" ? config.effort.trim() : "";
        return effort || undefined;
    }

    get stream(): boolean {
        return this.body.stream === true;
    }

    /** See `claudeCodeThreadKey`; undefined without a Claude Code session. */
    get threadKey(): string | undefined {
        const session = this.sessionId;
        return session ? claudeCodeThreadKey(session, this.body.system) : undefined;
    }

    /** The body without Claude Code's summary prompt: the text blocks carrying it go, and an empty message too. */
    withoutCompactionPrompt(): Record<string, unknown> {
        const prompt = this.messages[this.promptIndex];

        if (!isObject(prompt)) {
            return this.body;
        }

        const content = Array.isArray(prompt.content)
            ? prompt.content.filter(
                  (block) =>
                      !(
                          isObject(block) &&
                          block.type === "text" &&
                          typeof block.text === "string" &&
                          block.text.includes(CLAUDE_CODE_COMPACTION_MARK)
                      )
              )
            : [];
        const kept = content.length > 0 ? [{ ...prompt, content }] : [];
        const index = this.promptIndex;

        return {
            ...this.body,
            messages: [...this.messages.slice(0, index), ...kept, ...this.messages.slice(index + 1)],
        };
    }

    /**
     * The body with a length limit added to the prompt's user message, at its end so the cached prefix stays whole.
     * A Codex model unasked wrote 15K to 26K tokens of summary, 6 to 8 minutes of output (2026-10-27).
     */
    withSummaryLimit(words: number): Record<string, unknown> {
        const prompt = this.messages[this.promptIndex];

        if (!isObject(prompt)) {
            return this.body;
        }

        const limit = `Keep the whole summary under ${words} words. Prefer exact identifiers, file paths, commands, commit SHAs and open tasks over narration.`;
        const content =
            typeof prompt.content === "string"
                ? [
                      { type: "text", text: prompt.content },
                      { type: "text", text: limit },
                  ]
                : Array.isArray(prompt.content)
                  ? [...prompt.content, { type: "text", text: limit }]
                  : prompt.content;

        return {
            ...this.body,
            messages: this.messages.map((message, at) => (at === this.promptIndex ? { ...prompt, content } : message)),
        };
    }
}

/** The probe's answer: a one-token message, so the probe needs no upstream call (a Codex model ignores the cap). */
export function modelProbeReply(model: string): Record<string, unknown> {
    return {
        id: `msg_probe_${crypto.randomUUID().replaceAll("-", "")}`,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: "Hi" }],
        stop_reason: "max_tokens",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 1 },
    };
}

/** Claude Code's subagent tool. */
export const CLAUDE_CODE_AGENT_TOOL = "Agent";

/**
 * An Agent call's `model` beats the subagent definition's model in Claude Code, and a main loop that follows a
 * "set model on every Agent call" rule from CLAUDE.md picks a Claude alias: a `sol` subagent ran on Sonnet
 * (2026-10-25). For the subagents a session defined with their own model, the call's `model` is dropped, so the
 * definition decides. Every other subagent keeps the model the main loop chose.
 */
export function sessionAgentModelWins(agents: ReadonlySet<string>): (input: unknown) => unknown {
    return (input) => {
        if (!isObject(input) || typeof input.subagent_type !== "string" || !agents.has(input.subagent_type)) {
            return input;
        }

        if (input.model === undefined) {
            return input;
        }

        const { model, ...rest } = input;
        logger.info(
            { subagent: input.subagent_type, model },
            "ai-proxy: dropped the Agent call's model, the session's subagent runs on its own"
        );
        return rest;
    };
}
