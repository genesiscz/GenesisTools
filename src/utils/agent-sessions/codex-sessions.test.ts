import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { parseCodexRollout, searchCodexSessions } from "./codex-sessions";

const ID = "01a067d4-d2b0-7532-8f59-9af2a29c2d0e";

function rolloutLine(obj: unknown): string {
    return `${SafeJSON.stringify(obj)}\n`;
}

describe("parseCodexRollout", () => {
    test("reads session_meta and the first real user prompt, skipping AGENTS.md", () => {
        const dir = mkdtempSync(join(tmpdir(), "codex-rollout-"));
        const path = join(dir, `rollout-2026-09-03-${ID}.jsonl`);
        writeFileSync(
            path,
            rolloutLine({
                timestamp: "2026-09-03T15:13:15.994Z",
                type: "session_meta",
                payload: { session_id: ID, cwd: "/Users/me/Projects/shop" },
            }) +
                rolloutLine({
                    type: "response_item",
                    payload: {
                        type: "message",
                        role: "user",
                        content: [
                            {
                                type: "input_text",
                                text: "# AGENTS.md instructions for /Users/me/Projects/shop\nDo not",
                            },
                        ],
                    },
                }) +
                rolloutLine({
                    type: "response_item",
                    payload: {
                        type: "message",
                        role: "user",
                        content: [
                            {
                                type: "input_text",
                                text: "codex mcp login apify doesnt work, handle auth in mcp-manager",
                            },
                        ],
                    },
                })
        );

        const session = parseCodexRollout(path);
        expect(session?.sessionId).toBe(ID);
        expect(session?.cwd).toBe("/Users/me/Projects/shop");
        expect(session?.kind).toBe("codex");
        expect(session?.prompt).toContain("mcp-manager");
        expect(session?.title).toContain("codex mcp login");
    });
});

describe("searchCodexSessions", () => {
    test("finds a session by prompt text in a dated tree", () => {
        const root = mkdtempSync(join(tmpdir(), "codex-root-"));
        const day = join(root, "2026", "09", "03");
        mkdirSync(day, { recursive: true });
        const path = join(day, `rollout-2026-09-03T17-13-15-${ID}.jsonl`);
        writeFileSync(
            path,
            rolloutLine({
                timestamp: "2026-09-03T15:13:15.994Z",
                type: "session_meta",
                payload: { session_id: ID, cwd: "/Users/me/Projects/shop" },
            }) +
                rolloutLine({
                    type: "response_item",
                    payload: {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: "handle auth in mcp-manager" }],
                    },
                })
        );

        const hits = searchCodexSessions([root], { query: "mcp-manager" });
        expect(hits).toHaveLength(1);
        expect(hits[0]?.sessionId).toBe(ID);
    });
});
