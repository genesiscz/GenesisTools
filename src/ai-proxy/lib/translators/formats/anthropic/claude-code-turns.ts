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

/** A Claude Code compaction turn: its last user message carries the compaction prompt. */
export function isClaudeCodeCompactionTurn(body: { messages?: unknown }): boolean {
    return compactionPromptIndex(messagesOf(body)) >= 0;
}

/** The compaction turn without Claude Code's summary prompt: the text blocks carrying it go, and an empty message too. */
export function withoutCompactionPrompt(body: Record<string, unknown>): Record<string, unknown> {
    const messages = messagesOf(body);
    const index = compactionPromptIndex(messages);
    const prompt = messages[index];

    if (!isObject(prompt)) {
        return body;
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

    return { ...body, messages: [...messages.slice(0, index), ...kept, ...messages.slice(index + 1)] };
}

/**
 * The compaction turn with a length limit added to the prompt's user message, at its end so the cached prefix stays
 * whole. A Codex model unasked wrote 15K to 26K tokens of summary, 6 to 8 minutes of output (2026-10-27).
 */
export function limitCompactionSummary(body: Record<string, unknown>, words: number): Record<string, unknown> {
    const messages = messagesOf(body);
    const index = compactionPromptIndex(messages);
    const prompt = messages[index];

    if (!isObject(prompt)) {
        return body;
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

    return { ...body, messages: messages.map((message, at) => (at === index ? { ...prompt, content } : message)) };
}

/**
 * Claude Code's `model_validation` probe: one user "Hi" at `max_tokens: 1`, sent once when `/model` or `--model`
 * names an id it does not know (Claude Code 2.1.296 binary, checked 2026-10-25). It throws on any error, and gives
 * up after 15 s with no retry.
 */
export function isClaudeCodeModelProbe(body: { max_tokens?: unknown; messages?: unknown; tools?: unknown }): boolean {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const [only] = messages;

    return (
        body.max_tokens === 1 &&
        messages.length === 1 &&
        body.tools === undefined &&
        isObject(only) &&
        only.role === "user" &&
        textOf(only.content) === "Hi"
    );
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
