import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { findSessionsByTitle, lastClaudeTitle, rankByTitle } from "./session-title";

const titled = (title: string, mtime: number) => ({ sessionId: title, title, mtime, locator: title });

describe("rankByTitle", () => {
    it("prefers an exact title over longer titles that contain it, newest first", () => {
        const ranked = rankByTitle("Build", [titled("Build the thing", 3), titled("build", 1), titled("BUILD", 2)]);

        expect(ranked.map((session) => session.mtime)).toEqual([2, 1]);
    });

    it("falls back to a contained title, and matches nothing for an empty query", () => {
        expect(rankByTitle("thing", [titled("Build the thing", 3)])).toHaveLength(1);
        expect(rankByTitle("  ", [titled("x", 1)])).toEqual([]);
    });
});

describe("lastClaudeTitle", () => {
    it("takes the last /rename and decodes JSON escapes", () => {
        const text = [
            '{"type":"custom-title","customTitle":"first","sessionId":"a"}',
            '{"type":"user"}',
            '{"type":"custom-title","customTitle":"say \\"hi\\"","sessionId":"a"}',
        ].join("\n");

        expect(lastClaudeTitle(text)).toBe('say "hi"');
        expect(lastClaudeTitle('{"type":"user"}')).toBeNull();
    });
});

describe("findSessionsByTitle", () => {
    it("finds a Claude transcript by title and skips old files and subagent folders", () => {
        const root = mkdtempSync(join(tmpdir(), "titles-"));
        const project = join(root, "-proj");
        mkdirSync(join(project, "subagents"), { recursive: true });
        const fresh = join(project, "11111111-aaaa-bbbb-cccc-000000000001.jsonl");
        const old = join(project, "22222222-aaaa-bbbb-cccc-000000000002.jsonl");
        writeFileSync(fresh, '{"type":"custom-title","customTitle":"nightly-run","sessionId":"x"}\n');
        writeFileSync(old, '{"type":"custom-title","customTitle":"nightly-run","sessionId":"y"}\n');
        writeFileSync(
            join(project, "subagents", "agent-1.jsonl"),
            '{"type":"custom-title","customTitle":"nightly-run"}\n'
        );
        const longAgo = new Date(Date.now() - 40 * 86_400_000);
        utimesSync(old, longAgo, longAgo);

        const hits = findSessionsByTitle("nightly-run", { provider: "claude", roots: [root] });

        expect(hits.map((hit) => hit.locator)).toEqual([fresh]);
        expect(hits[0].sessionId).toBe("11111111-aaaa-bbbb-cccc-000000000001");
    });

    it("finds a Grok session by its summary and a Codex thread by its name", () => {
        const root = mkdtempSync(join(tmpdir(), "titles-grok-"));
        const dir = join(root, "%2Ftmp%2Fx", "01aaaaaa-0000-7000-8000-000000000001");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "summary.json"), '{"info":{"id":"01aaaaaa"},"session_summary":"cmux-grok"}');
        writeFileSync(join(dir, "updates.jsonl"), "{}\n");
        const index = join(mkdtempSync(join(tmpdir(), "titles-codex-")), "session_index.jsonl");
        writeFileSync(
            index,
            '{"id":"019c0000-0000-7000-8000-000000000009","thread_name":"Plan the merge","updated_at":"2026-03-07T22:43:36Z"}\n'
        );

        expect(findSessionsByTitle("cmux-grok", { provider: "grok", roots: [root] })[0]?.locator).toBe(
            join(dir, "updates.jsonl")
        );
        expect(findSessionsByTitle("plan the merge", { provider: "codex", codexIndexPath: index })[0]?.locator).toBe(
            "019c0000-0000-7000-8000-000000000009"
        );
    });

    it("reads a renamed Codex thread by its last name only, once", () => {
        const index = join(mkdtempSync(join(tmpdir(), "titles-codex-")), "session_index.jsonl");
        const id = "019c0000-0000-7000-8000-000000000010";
        writeFileSync(
            index,
            [
                `{"id":"${id}","thread_name":"old name","updated_at":"2026-03-07T22:43:36Z"}`,
                `{"id":"${id}","thread_name":"new name","updated_at":"2026-03-08T22:43:36Z"}`,
                `{"id":"${id}","thread_name":"new name","updated_at":"2026-03-09T22:43:36Z"}`,
            ].join("\n")
        );

        expect(findSessionsByTitle("old name", { provider: "codex", codexIndexPath: index })).toEqual([]);
        expect(findSessionsByTitle("new name", { provider: "codex", codexIndexPath: index })).toHaveLength(1);
    });

    it("reads the session index of every home CODEX_HOME names", async () => {
        const work = mkdtempSync(join(tmpdir(), "titles-codex-work-"));
        const side = mkdtempSync(join(tmpdir(), "titles-codex-side-"));
        writeFileSync(
            join(work, "session_index.jsonl"),
            '{"id":"019c0000-0000-7000-8000-000000000011","thread_name":"work thread","updated_at":"2026-03-07T22:43:36Z"}\n'
        );
        writeFileSync(
            join(side, "session_index.jsonl"),
            '{"id":"019c0000-0000-7000-8000-000000000012","thread_name":"side thread","updated_at":"2026-03-07T22:43:36Z"}\n'
        );

        await env.testing.withOverrides({ CODEX_HOME: `${work}, ${side}` }, () => {
            expect(findSessionsByTitle("work thread", { provider: "codex" })[0]?.sessionId).toBe(
                "019c0000-0000-7000-8000-000000000011"
            );
            expect(findSessionsByTitle("side thread", { provider: "codex" })[0]?.sessionId).toBe(
                "019c0000-0000-7000-8000-000000000012"
            );
        });
    });
});
