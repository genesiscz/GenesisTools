import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { lastClaudeTitle } from "../../agent-sessions/readers/claude-title";
import { codexSessions, createCodexLocate } from "../../agent-sessions/readers/codex-locate";
import { grokTitleOf } from "../../agent-sessions/readers/grok-title";
import { directReads, type FolderReads } from "./resolve";
import { findSessionsByTitle, rankByTitle } from "./session-title";

/** Codex title search over the homes under `home` (and `CODEX_HOME`), ranked as `findSessionsByTitle` ranks them. */
const codexTitles = (home: string) => (query: string) =>
    rankByTitle(query, createCodexLocate(home).titledSessions({ options: { provider: "codex" }, roots: [], now: 0 }));

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

    it("reads the title of a rename row that ends past the read window", () => {
        const text = [
            '{"type":"custom-title","customTitle":"first","sessionId":"a"}',
            `{"type":"custom-title","customTitle":"second","sessionId":"a","note":"${"x".repeat(5_000)}"}`,
        ].join("\n");

        expect(lastClaudeTitle(text)).toBe("second");
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

    it("finds a Grok session by the title the session lists show, renamed or generated, else by its summary", () => {
        expect(
            grokTitleOf({ generated_title: "shop", title_is_manual: true, session_summary: "Shop layout notes" })
        ).toBe("shop");
        // Not renamed: the generated title is still the name the lists show (one rule with discovery, 2026-10-31).
        expect(
            grokTitleOf({ generated_title: "guess", title_is_manual: false, session_summary: "Shop layout notes" })
        ).toBe("guess");
        expect(grokTitleOf({ generated_title: " ", session_summary: "Shop layout notes" })).toBe("Shop layout notes");
        expect(grokTitleOf({})).toBeNull();
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
            // An empty fixture home holds no legacy profile homes, so the real `~/.codex-*` indexes are never read.
            const titles = codexTitles(mkdtempSync(join(tmpdir(), "titles-codex-home-")));
            expect(titles("work thread")[0]?.sessionId).toBe("019c0000-0000-7000-8000-000000000011");
            expect(titles("side thread")[0]?.sessionId).toBe("019c0000-0000-7000-8000-000000000012");
        });
    });

    it("takes a thread's title from the home of the rollout its id resolves to", async () => {
        const home = mkdtempSync(join(tmpdir(), "titles-codex-legacy-"));
        const id = "019c0000-0000-7000-8000-000000000021";
        const rolloutIn = (codexHome: string, title: string, mtimeSec: number) => {
            const day = join(home, codexHome, "sessions", "2026", "10", "31");
            mkdirSync(day, { recursive: true });
            const rollout = join(day, `rollout-2026-10-31T10-00-00-${id}.jsonl`);
            writeFileSync(rollout, "{}\n");
            utimesSync(rollout, mtimeSec, mtimeSec);
            writeFileSync(
                join(home, codexHome, "session_index.jsonl"),
                `{"id":"${id}","thread_name":"${title}","updated_at":"2026-10-31T10:00:00Z"}\n`
            );
            return rollout;
        };
        const current = rolloutIn(".codex", "New", 2_000_000_000);
        rolloutIn(".codex-work", "Old", 1_000_000_000);

        await env.testing.withOverrides({ CODEX_HOME: undefined }, () => {
            const titles = codexTitles(home);
            expect(titles("New").map((hit) => hit.locator)).toEqual([current]);
            expect(titles("Old")).toEqual([]);
        });
    });

    it("lists each rollout folder once however many threads two homes share", () => {
        const home = mkdtempSync(join(tmpdir(), "titles-codex-shared-"));
        const ids = ["019c0000-0000-7000-8000-000000000031", "019c0000-0000-7000-8000-000000000032"];

        for (const codexHome of [".codex", ".codex-work"]) {
            const day = join(home, codexHome, "sessions", "2026", "10", "31");
            mkdirSync(day, { recursive: true });
            for (const id of ids) {
                writeFileSync(join(day, `rollout-2026-10-31T10-00-00-${id}.jsonl`), "{}\n");
            }
            writeFileSync(
                join(home, codexHome, "session_index.jsonl"),
                ids.map((id) => `{"id":"${id}","thread_name":"t ${id}","updated_at":"2026-10-31T10:00:00Z"}\n`).join("")
            );
        }

        const listed = new Map<string, number>();
        const counting: FolderReads = {
            ...directReads,
            listDir: (path) => {
                listed.set(path, (listed.get(path) ?? 0) + 1);
                return directReads.listDir(path);
            },
        };

        const sessions = codexSessions(
            [".codex", ".codex-work"].map((codexHome) => join(home, codexHome, "session_index.jsonl")),
            counting
        );
        expect(sessions).toHaveLength(2);
        expect(listed.size).toBeGreaterThan(0);
        expect([...listed.values()].every((count) => count === 1)).toBe(true);
    });

    it("orders Codex titles by an updated_at in epoch seconds as discovery does", async () => {
        const home = mkdtempSync(join(tmpdir(), "titles-codex-epoch-"));
        writeFileSync(
            join(home, "session_index.jsonl"),
            [
                '{"id":"019c0000-0000-7000-8000-000000000031","thread_name":"nightly","updated_at":"2025-01-01T00:00:00Z"}',
                '{"id":"019c0000-0000-7000-8000-000000000032","thread_name":"nightly","updated_at":1793000000}',
            ].join("\n")
        );

        await env.testing.withOverrides({ CODEX_HOME: home }, () => {
            const hits = codexTitles(mkdtempSync(join(tmpdir(), "titles-codex-home-")))("nightly");
            expect(hits.map((hit) => [hit.sessionId, hit.mtime])).toEqual([
                ["019c0000-0000-7000-8000-000000000032", 1_793_000_000_000],
                ["019c0000-0000-7000-8000-000000000031", Date.parse("2025-01-01T00:00:00Z")],
            ]);
        });
    });
});
