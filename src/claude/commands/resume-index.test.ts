import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeHistoryAdapter } from "@genesiscz/utils/agent-sessions/native-adapter";
import type { AgentSearchFilters, AgentSessionAdapter } from "@genesiscz/utils/agent-sessions/types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { assertClaudeResumeHome, loadClaudeResumeCandidates } from "./resume";

const ID = "11111111-2222-4333-8444-555555555555";
function fixture() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "gt-claude-resume-index-")));
    const root = join(home, "projects");
    mkdirSync(join(root, "-projects-shop"), { recursive: true });
    const file = join(root, "-projects-shop", `${ID}.jsonl`);
    writeFileSync(
        file,
        `${SafeJSON.stringify({ type: "user", sessionId: ID, cwd: "/projects/shop", message: { content: "Invoice callback" } })}\n`
    );
    return { home, root, file };
}

test.each([ID, "Invoice callback"])("Claude resume auto-indexes provider-only roots for %s", async (query) => {
    const source = fixture();
    const db = new Database(":memory:");
    try {
        const adapter = createNativeHistoryAdapter({ kind: "claude", roots: [source.root], database: db });
        const hits = await loadClaudeResumeCandidates({ query, cwd: "/projects/shop", adapter });
        expect(hits).toHaveLength(1);
        expect(hits[0]?.sessionId).toBe(ID);
        expect(hits[0]?.sourceHome).toBe(source.home);
        expect(hits[0]?.filePath).toBe(source.file);
        expect((await adapter.status?.())?.sessions).toBe(1);
        appendFileSync(
            source.file,
            `${SafeJSON.stringify({ type: "custom-title", customTitle: "Renamed invoice", sessionId: ID })}\n`
        );
        expect(
            (await loadClaudeResumeCandidates({ query: "Renamed invoice", cwd: "/projects/shop", adapter }))[0]?.name
        ).toBe("Renamed invoice");
    } finally {
        db.close();
    }
});

test("content resume retains duplicate native IDs from distinct homes", async () => {
    const a = fixture();
    const b = fixture();
    for (const source of [a, b]) {
        appendFileSync(
            source.file,
            `${SafeJSON.stringify({ type: "assistant", sessionId: ID, cwd: "/projects/shop", message: { content: [{ type: "text", text: "deep transcript phrase" }] } })}\n`
        );
    }
    const db = new Database(":memory:");
    try {
        const adapter = createNativeHistoryAdapter({ kind: "claude", roots: [a.root, b.root], database: db });
        const hits = await loadClaudeResumeCandidates({
            query: "deep transcript phrase",
            cwd: "/projects/shop",
            adapter,
        });
        expect(hits).toHaveLength(2);
        expect(new Set(hits.map((hit) => hit.sourceKey)).size).toBe(2);
        expect(new Set(hits.map((hit) => hit.sourceHome))).toEqual(new Set([a.home, b.home]));
        expect(await loadClaudeResumeCandidates({ query: "absent phrase", cwd: "/projects/shop", adapter })).toEqual(
            []
        );
    } finally {
        db.close();
    }
});

test("foreign Claude homes are refused with an explicit home command instead of migration", () => {
    const source = fixture();
    const other = fixture();
    expect(() =>
        assertClaudeResumeHome({
            session: { sourceHome: source.home, filePath: source.file, sessionId: ID },
            effectiveHome: other.home,
        })
    ).toThrow(/CLAUDE_CONFIG_DIR=/);
    expect(() =>
        assertClaudeResumeHome({
            session: { sourceHome: source.home, filePath: source.file, sessionId: ID },
            effectiveHome: source.home,
        })
    ).not.toThrow();
});

test("configured Claude home honors realpath aliases without requiring a move", () => {
    const source = fixture();
    const alias = join(source.home, "home-alias");
    symlinkSync(source.home, alias);
    env.testing.set("CLAUDE_CONFIG_DIR", alias);
    try {
        expect(() =>
            assertClaudeResumeHome({ session: { sourceHome: source.home, sessionId: ID, filePath: source.file } })
        ).not.toThrow();
    } finally {
        env.testing.unset("CLAUDE_CONFIG_DIR");
    }
});

// Regression: an unavailable native UUID must never select a different session that only mentions it.
test.each(["title", "body"] as const)(
    "missing full Claude UUID does not fall back to %s mentions",
    async (location) => {
        const source = fixture();
        const missing = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        const row =
            location === "title"
                ? { type: "custom-title", sessionId: ID, customTitle: `Discussing ${missing}` }
                : {
                      type: "assistant",
                      sessionId: ID,
                      cwd: "/projects/shop",
                      message: { content: [{ type: "text", text: `Referenced ${missing}` }] },
                  };
        appendFileSync(source.file, `${SafeJSON.stringify(row)}\n`);
        const db = new Database(":memory:");
        try {
            const adapter = createNativeHistoryAdapter({ kind: "claude", roots: [source.root], database: db });
            expect(await loadClaudeResumeCandidates({ query: missing, cwd: "/projects/shop", adapter })).toEqual([]);
        } finally {
            db.close();
        }
    }
);

test("a full Claude UUID resolves across projects while ordinary text remains scoped", async () => {
    const source = fixture();
    const db = new Database(":memory:");
    try {
        const adapter = createNativeHistoryAdapter({ kind: "claude", roots: [source.root], database: db });
        const found = await loadClaudeResumeCandidates({ query: ID, cwd: "/projects/other", adapter });
        expect(found).toHaveLength(1);
        expect(found[0]?.sessionId).toBe(ID);
        expect(found[0]?.sourceHome).toBe(source.home);
        expect(
            await loadClaudeResumeCandidates({ query: "Invoice callback", cwd: "/projects/other", adapter })
        ).toEqual([]);
    } finally {
        db.close();
    }
});

test("content fallback keeps its own bounded result limit", async () => {
    // Regression test: PR #370 review thread 17 — exhaustive identity catalog limits leaked into full-text search.
    const seen: { list?: AgentSearchFilters; search?: AgentSearchFilters } = {};
    const adapter: AgentSessionAdapter = {
        kind: "claude",
        list: async (filters) => {
            seen.list = filters;
            return [];
        },
        search: async (filters) => {
            seen.search = filters;
            return [];
        },
    };

    await loadClaudeResumeCandidates({ query: "deep transcript phrase", cwd: "/projects/shop", limit: 7, adapter });

    expect(seen.list?.limit).toBe(Number.MAX_SAFE_INTEGER);
    expect(seen.search?.limit).toBe(7);
});
