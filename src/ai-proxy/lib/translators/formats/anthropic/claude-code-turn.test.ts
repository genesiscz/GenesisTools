import { describe, expect, it } from "bun:test";
import {
    CLAUDE_CODE_COMPACTION_MARK,
    ClaudeCodeTurn,
} from "@app/ai-proxy/lib/translators/formats/anthropic/claude-code-turns";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * Characterization of how the proxy reads one Claude Code request, per Claude Code version. Pinned before the parse
 * moved into one turn object; every row must read the same after it.
 */

type Body = Record<string, unknown>;

interface Observed {
    kind: "compaction" | "probe" | "normal";
    retry: boolean;
    missed: boolean;
    sessionId?: string;
    withoutPrompt: unknown;
    limited: unknown;
}

function observe(body: Body): Observed {
    const turn = ClaudeCodeTurn.read(body);
    return {
        kind: turn.kind,
        retry: turn.isCompactionRetry,
        missed: turn.missedCompaction,
        sessionId: turn.sessionId,
        withoutPrompt: turn.withoutCompactionPrompt().messages,
        limited: turn.withSummaryLimit(100).messages,
    };
}

const session = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const metadata = { user_id: SafeJSON.stringify({ session_id: session }) };
const history = [
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: "Fixed." },
];
const promptBlock = { type: "text", text: `${CLAUDE_CODE_COMPACTION_MARK}\nSummarize the conversation.` };
const prompt = { role: "user", content: [promptBlock] };
const limitBlock = {
    type: "text",
    text: "Keep the whole summary under 100 words. Prefer exact identifiers, file paths, commands, commit SHAs and open tasks over narration.",
};

describe("one Claude Code request, read per version", () => {
    it("2.1.296: the compaction prompt is the last message", () => {
        const body = { metadata, messages: [...history, prompt] };

        expect(observe(body)).toEqual({
            kind: "compaction",
            retry: false,
            missed: false,
            sessionId: session,
            withoutPrompt: history,
            limited: [...history, { role: "user", content: [promptBlock, limitBlock] }],
        });
    });

    it("2.1.311: the second ask after a reply without a <summary> tag", () => {
        const retry = {
            role: "user",
            content: [promptBlock, { type: "text", text: "For this reply only, wrap the summary in <summary> tags." }],
        };
        const body = { metadata, messages: [...history, retry] };
        const observed = observe(body);

        expect(observed.kind).toBe("compaction");
        expect(observed.retry).toBe(true);
        expect(observed.withoutPrompt).toEqual([
            ...history,
            {
                role: "user",
                content: [{ type: "text", text: "For this reply only, wrap the summary in <summary> tags." }],
            },
        ]);
    });

    it("2.1.312: a system token-budget message after the prompt", () => {
        const budget = { role: "system", content: "Token budget: 20000." };
        const body = { metadata, messages: [...history, prompt, budget] };

        expect(observe(body)).toEqual({
            kind: "compaction",
            retry: false,
            missed: false,
            sessionId: session,
            withoutPrompt: [...history, budget],
            limited: [...history, { role: "user", content: [promptBlock, limitBlock] }, budget],
        });
    });

    it("a prompt that a later assistant reply follows is missed, not a compaction turn", () => {
        const body = { messages: [...history, prompt, { role: "assistant", content: "Summary." }] };
        const observed = observe(body);

        expect(observed.kind).toBe("normal");
        expect(observed.missed).toBe(true);
        expect(observed.withoutPrompt).toEqual(body.messages);
    });

    it("a prompt quoted in a tool result is neither a turn nor missed", () => {
        const quoted = {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: `${CLAUDE_CODE_COMPACTION_MARK} quoted` }],
        };
        const observed = observe({ messages: [...history, quoted] });

        expect(observed.kind).toBe("normal");
        expect(observed.missed).toBe(false);
    });

    it("a string-content prompt is a compaction turn, and the limit becomes a second text block", () => {
        const body = { messages: [...history, { role: "user", content: `${CLAUDE_CODE_COMPACTION_MARK} go` }] };
        const observed = observe(body);

        expect(observed.kind).toBe("compaction");
        expect(observed.withoutPrompt).toEqual(history);
        expect(observed.limited).toEqual([
            ...history,
            { role: "user", content: [{ type: "text", text: `${CLAUDE_CODE_COMPACTION_MARK} go` }, limitBlock] },
        ]);
    });

    it("the /model probe: one user Hi at max_tokens 1 with no tools", () => {
        expect(observe({ max_tokens: 1, messages: [{ role: "user", content: "Hi" }] }).kind).toBe("probe");
        expect(observe({ max_tokens: 1, tools: [], messages: [{ role: "user", content: "Hi" }] }).kind).toBe("normal");
    });

    it("a normal turn without metadata has no session", () => {
        const observed = observe({ messages: history });

        expect(observed).toEqual({
            kind: "normal",
            retry: false,
            missed: false,
            sessionId: undefined,
            withoutPrompt: history,
            limited: history,
        });
    });
});
