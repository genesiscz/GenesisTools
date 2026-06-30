import { describe, expect, test } from "bun:test";
import { nextSubagentId } from "../lib/derived-registry";
import { deriveMainAgentId, ensureMainPrefix, isMainId } from "../lib/id-gen";
import type { AgentRecord } from "../lib/types";

function rec(agent_id: string): AgentRecord {
    return {
        agent_id,
        agent_name: agent_id,
        is_main: false,
        role: null,
        registered_at: "t",
        logged_in_at: null,
        logged_out_at: null,
        mode: null,
        meta: {},
    };
}

describe("derived-registry.nextSubagentId", () => {
    test("returns agt_0001 from an empty registry", () => {
        expect(nextSubagentId([])).toBe("agt_0001");
    });

    test("monotonic from max-suffix+1 (not count+1)", () => {
        const records = [rec("agt_0001"), rec("agt_0002"), rec("agt_0003")];
        expect(nextSubagentId(records)).toBe("agt_0004");
    });

    test("respects gaps — max-suffix+1, not count+1", () => {
        // User passed `--agent-id agt_0005` explicitly; count would be 2 but max+1 must be 6
        const records = [rec("agt_0001"), rec("agt_0005")];
        expect(nextSubagentId(records)).toBe("agt_0006");
    });

    test("ignores non-agt_ ids when computing max", () => {
        const records = [rec("agt_0001"), rec("main_lead"), rec("agt_0003")];
        expect(nextSubagentId(records)).toBe("agt_0004");
    });

    test("hex suffix > 0xffff still increments (overflow is a runtime concern, not allocator)", () => {
        const records = [rec("agt_0010"), rec("agt_00ff")];
        expect(nextSubagentId(records)).toBe("agt_0100");
    });
});

describe("id-gen", () => {
    test("deriveMainAgentId slugs the session", () => {
        const id = deriveMainAgentId("ABCDEFGH-12345678");
        expect(id).toBe("main_abcdefgh1234");
    });

    test("deriveMainAgentId falls back to random when session has no alphanumerics", () => {
        const id = deriveMainAgentId("!!!!");
        expect(id).toMatch(/^main_[0-9a-f]{4,6}$/);
    });

    test("ensureMainPrefix is idempotent on already-prefixed ids", () => {
        expect(ensureMainPrefix("main_abc12345", "session-xyz")).toBe("main_abc12345");
    });

    test("ensureMainPrefix rewrites agt_ prefix to main_", () => {
        expect(ensureMainPrefix("agt_abc12345", "session-xyz")).toBe("main_abc12345");
    });

    test("ensureMainPrefix prepends to bare ids", () => {
        expect(ensureMainPrefix("custom", "session-xyz")).toBe("main_custom");
    });

    test("isMainId detects main_ prefix", () => {
        expect(isMainId("main_xxx")).toBe(true);
        expect(isMainId("agt_xxx")).toBe(false);
        expect(isMainId("")).toBe(false);
    });
});
