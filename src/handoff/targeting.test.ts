import { describe, expect, test } from "bun:test";
import {
    agentFilterMatches,
    canonicalAgent,
    handoffNameFor,
    isKnownAgent,
    MAX_HANDOFF_NAME_LENGTH,
    normalizeAgentInput,
    normalizeHandoffName,
    normalizeTargetInput,
    recipientCheck,
    sessionFilterMatches,
} from "./targeting";
import { byFor } from "./test-utils";
import type { HandoffEventBy } from "./types";

const FULL = "cd4e9457-105b-45f5-829d-9c4f554df36a";
const LEADING_SEGMENT = "cd4e9457";

function on(agent: string, sessionId: string | null, sessionName: string | null = null): HandoffEventBy {
    return { ...byFor(sessionId, sessionName), agent };
}

describe("harness names", () => {
    test("the runtime's claude-code and a poster's claude are the same harness", () => {
        // AgentRuntimeContext.agent says "claude-code"; humans and tool schemas say
        // "claude". Without this they would read as a mismatch against each other.
        expect(canonicalAgent("claude-code")).toBe("claude");
        expect(canonicalAgent("Claude")).toBe("claude");
        expect(canonicalAgent("codex")).toBe("codex");
        expect(canonicalAgent("grok")).toBe("grok");
        expect(canonicalAgent("copilot")).toBe("copilot");
    });

    test("an undocumented name is not a harness", () => {
        expect(canonicalAgent("borg")).toBeNull();
        expect(canonicalAgent("")).toBeNull();
        expect(canonicalAgent(null)).toBeNull();
        expect(isKnownAgent("borg")).toBe(false);
    });

    test("input normalization keeps an undocumented name instead of dropping it", () => {
        expect(normalizeAgentInput("  CODEX ")).toBe("codex");
        expect(normalizeAgentInput("Claude-Code")).toBe("claude");
        expect(normalizeAgentInput("Borg")).toBe("borg");
        expect(normalizeAgentInput("   ")).toBeUndefined();
        expect(normalizeAgentInput(42)).toBeUndefined();
    });
});

describe("target normalization", () => {
    test("both doors store one shape", () => {
        expect(
            normalizeTargetInput({ sessionId: " sess-alpha ", sessionName: " worker ", agent: "Claude-Code" })
        ).toEqual({ sessionId: "sess-alpha", sessionName: "worker", agent: "claude" });
    });

    test("an agent alone is a valid target", () => {
        expect(normalizeTargetInput({ agent: "codex" })).toEqual({ agent: "codex" });
    });

    test("nothing usable normalizes to undefined", () => {
        expect(normalizeTargetInput({ sessionId: "   " })).toBeUndefined();
        expect(normalizeTargetInput({})).toBeUndefined();
        expect(normalizeTargetInput(null)).toBeUndefined();
        expect(normalizeTargetInput("codex")).toBeUndefined();
    });
});

describe("handoff names", () => {
    test("a name is a slug and can never look like an id", () => {
        expect(normalizeHandoffName("Fix e2e Active-filter semantics")).toBe("fix-e2e-active-filter-semantics");
        // `h_` survives id normalization; slugging turns the underscore into a hyphen,
        // so no name can collide with the id namespace.
        expect(normalizeHandoffName("h_abc")).toBe("h-abc");
        expect(normalizeHandoffName("  --Trim Me--  ")).toBe("trim-me");
    });

    test("a name with nothing to slug is no name", () => {
        expect(normalizeHandoffName("!!!")).toBeUndefined();
        expect(normalizeHandoffName("")).toBeUndefined();
        expect(normalizeHandoffName(undefined)).toBeUndefined();
    });

    test("long names are capped without a trailing hyphen", () => {
        const slug = normalizeHandoffName(`${"a".repeat(40)} ${"b".repeat(40)}`);
        expect(slug).toBeDefined();
        expect((slug as string).length).toBeLessThanOrEqual(MAX_HANDOFF_NAME_LENGTH);
        expect(slug).not.toEndWith("-");
    });

    test("a supplied name wins over the title, and the title is the default", () => {
        expect(handoffNameFor({ name: "Pick Me", title: "Some Title" })).toBe("pick-me");
        expect(handoffNameFor({ name: undefined, title: "Some Title" })).toBe("some-title");
        expect(handoffNameFor({ name: "!!!", title: "Some Title" })).toBe("some-title");
    });
});

describe("recipientCheck", () => {
    test("an untargeted handoff warns about nothing", () => {
        const check = recipientCheck({ target: undefined, by: on("codex", "sess-beta") });
        expect(check).toEqual({ agent: "not-targeted", session: "not-targeted", warnings: [] });
    });

    test("the intended harness gets no warning", () => {
        const check = recipientCheck({ target: { agent: "codex" }, by: on("codex", "sess-alpha") });
        expect(check.agent).toBe("match");
        expect(check.warnings).toEqual([]);
    });

    test("another harness is told to stop, and how its user can override", () => {
        const check = recipientCheck({ target: { agent: "codex" }, by: on("claude-code", "sess-alpha") });
        expect(check.agent).toBe("mismatch");
        const text = check.warnings.join(" ");
        expect(text).toContain('targets harness "codex"');
        expect(text).toContain('this session runs "claude"');
        expect(text).toContain("This task is for another harness");
        expect(text).toContain("unless your user explicitly asks");
        expect(text).toContain("claim it explicitly");
    });

    test("an undetectable caller harness is unverifiable, never a mismatch", () => {
        const check = recipientCheck({ target: { agent: "codex" }, by: on("unknown", "sess-alpha") });
        expect(check.agent).toBe("unverifiable");
        const text = check.warnings.join(" ");
        expect(text).toContain("unverifiable");
        expect(text).not.toContain("mismatch");
    });

    test("an undocumented target harness is unverifiable in both directions", () => {
        const check = recipientCheck({ target: { agent: "borg" }, by: on("codex", "sess-alpha") });
        expect(check.agent).toBe("unverifiable");
        expect(check.warnings.join(" ")).toContain("not a documented harness");
    });

    test("an explicit target sessionId that is not ours is a mismatch", () => {
        const check = recipientCheck({ target: { sessionId: "sess-alpha" }, by: on("claude-code", "sess-beta") });
        expect(check.session).toBe("mismatch");
        const text = check.warnings.join(" ");
        expect(text).toContain('targets sessionId "sess-alpha"');
        expect(text).toContain("This task is for another session");
    });

    test("an abbreviated target sessionId still names this session", () => {
        const check = recipientCheck({ target: { sessionId: LEADING_SEGMENT }, by: on("claude-code", FULL) });
        expect(check.session).toBe("match");
        expect(check.warnings).toEqual([]);
    });

    test("no sessionId of our own means unverifiable, never a mismatch", () => {
        const check = recipientCheck({ target: { sessionId: "sess-alpha" }, by: on("claude-code", null) });
        expect(check.session).toBe("unverifiable");
        const text = check.warnings.join(" ");
        expect(text).toContain("unverifiable");
        expect(text).not.toContain("mismatch");
    });

    test("a differing sessionName is a hint, not a mismatch — names are not unique", () => {
        const check = recipientCheck({
            target: { sessionName: "gt-worker" },
            by: on("claude-code", "sess-beta", "other-worker"),
        });
        expect(check.session).toBe("unverifiable");
        expect(check.warnings.join(" ")).toContain("not unique");
    });

    test("a matching sessionName is a match", () => {
        const check = recipientCheck({
            target: { sessionName: "gt-worker" },
            by: on("claude-code", "sess-beta", "gt-worker"),
        });
        expect(check.session).toBe("match");
        expect(check.warnings).toEqual([]);
    });
});

describe("list filter semantics", () => {
    test("the agent filter compares canonical harness names", () => {
        expect(agentFilterMatches({ agent: "claude" }, "claude-code")).toBe(true);
        expect(agentFilterMatches({ agent: "claude" }, "codex")).toBe(false);
        expect(agentFilterMatches(undefined, "codex")).toBe(false);
        expect(agentFilterMatches({ sessionId: "sess-alpha" }, "codex")).toBe(false);
    });

    test("an undocumented filter value falls back to literal text", () => {
        expect(agentFilterMatches({ agent: "borg" }, "Borg")).toBe(true);
        expect(agentFilterMatches({ agent: "borg" }, "codex")).toBe(false);
    });

    test("the session filter matches an id in either abbreviation direction, or the name", () => {
        expect(sessionFilterMatches({ sessionId: FULL }, FULL)).toBe(true);
        expect(sessionFilterMatches({ sessionId: LEADING_SEGMENT }, FULL)).toBe(true);
        expect(sessionFilterMatches({ sessionId: FULL }, LEADING_SEGMENT)).toBe(true);
        expect(sessionFilterMatches({ sessionId: FULL }, "cd4e9458")).toBe(false);
        expect(sessionFilterMatches({ sessionName: "gt-worker" }, "GT-Worker")).toBe(true);
        expect(sessionFilterMatches({ sessionName: "gt-worker" }, "other")).toBe(false);
        expect(sessionFilterMatches(undefined, "gt-worker")).toBe(false);
    });
});
