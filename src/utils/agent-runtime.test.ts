import { describe, expect, it } from "bun:test";
import { getAgentRuntimeContext } from "./agent-runtime";

describe("getAgentRuntimeContext", () => {
    it("detects claude-code from CLAUDE_CODE_SESSION_ID + reads git/project", () => {
        const ctx = getAgentRuntimeContext({}, { CLAUDE_CODE_SESSION_ID: "sess-123", CLAUDECODE: "1" });
        expect(ctx.agent).toBe("claude-code");
        expect(ctx.sessionId).toBe("sess-123");
        expect(ctx.isInAgent).toBe(true);
        expect(typeof ctx.project).toBe("string");
        expect(ctx.project.length).toBeGreaterThan(0);
    });

    it("honors explicit overrides over env", () => {
        const ctx = getAgentRuntimeContext(
            { sessionId: "override", project: "Foo" },
            { CLAUDE_CODE_SESSION_ID: "env" }
        );
        expect(ctx.sessionId).toBe("override");
        expect(ctx.project).toBe("Foo");
    });

    it("agent=unknown when no agent env present", () => {
        const ctx = getAgentRuntimeContext({}, {});
        expect(ctx.agent).toBe("unknown");
        expect(ctx.sessionId).toBeNull();
    });

    it("detects codex from CODEX_CI and reads CODEX_THREAD_ID as sessionId", () => {
        const ctx = getAgentRuntimeContext({}, { CODEX_CI: "1", CODEX_THREAD_ID: "thr-42" });
        expect(ctx.agent).toBe("codex");
        expect(ctx.sessionId).toBe("thr-42");
        expect(ctx.isInAgent).toBe(true);
    });

    it("codex detected via CODEX_THREAD_ID even if CODEX_CI absent", () => {
        const ctx = getAgentRuntimeContext({}, { CODEX_THREAD_ID: "thr-9" });
        expect(ctx.agent).toBe("codex");
        expect(ctx.sessionId).toBe("thr-9");
    });
});
