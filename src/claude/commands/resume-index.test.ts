import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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

test("a name match older than the display limit is not hidden by a recent one", async () => {
    // Regression test: PR #370 review thread 8 — the identity pass must see the whole indexed
    // catalog, not the most recent `--limit` rows, or one weak recent hit suppresses an older
    // exact one and the single survivor is auto-selected without a TTY.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "gt-claude-resume-window-")));
    const root = join(home, "projects");
    const project = join(root, "-projects-shop");
    mkdirSync(project, { recursive: true });
    const start = Date.UTC(2026, 8, 1) / 1000;
    const titles = ["handoff-v2", ...Array.from({ length: 22 }, (_, index) => `routine work ${index}`), "handoff note"];
    const ids = titles.map((_, index) => `${String(index + 10).padStart(8, "1")}-2222-4333-8444-555555555555`);

    titles.forEach((title, index) => {
        const file = join(project, `${ids[index]}.jsonl`);
        writeFileSync(
            file,
            `${SafeJSON.stringify({ type: "user", sessionId: ids[index], cwd: "/projects/shop", message: { content: `entry ${index}` } })}\n${SafeJSON.stringify({ type: "custom-title", customTitle: title, sessionId: ids[index] })}\n`
        );
        // Oldest first, so `handoff-v2` sits four sessions beyond the default display limit of 20.
        const stamp = new Date((start + index * 3600) * 1000);
        utimesSync(file, stamp, stamp);
    });

    const db = new Database(":memory:");
    try {
        const adapter = createNativeHistoryAdapter({ kind: "claude", roots: [root], database: db });
        const hits = await loadClaudeResumeCandidates({ query: "handoff", cwd: "/projects/shop", adapter });

        expect(hits.map((hit) => hit.name).sort()).toEqual(["handoff note", "handoff-v2"]);
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

test("a first-prompt hit does not suppress the content pass that finds the session by name", async () => {
    // Regression test: `--resume reports` offered only the session whose opening prompt says the
    // word once, because that weak hit returned early and the content search never ran.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "gt-claude-resume-weak-")));
    const root = join(home, "projects");
    const project = join(root, "-projects-shop");
    mkdirSync(project, { recursive: true });
    const prompted = "11111111-2222-4333-8444-555555555551";
    const deep = "11111111-2222-4333-8444-555555555552";
    const namesake = "11111111-2222-4333-8444-555555555553";

    writeFileSync(
        join(project, `${prompted}.jsonl`),
        `${SafeJSON.stringify({ type: "user", sessionId: prompted, cwd: "/projects/shop", message: { content: "please attach the reports folder" } })}\n${SafeJSON.stringify({ type: "custom-title", customTitle: "weekly rollup", sessionId: prompted })}\n`
    );
    writeFileSync(
        join(project, `${deep}.jsonl`),
        `${SafeJSON.stringify({ type: "user", sessionId: deep, cwd: "/projects/shop", message: { content: "start here" } })}\n${SafeJSON.stringify({ type: "assistant", sessionId: deep, cwd: "/projects/shop", message: { content: [{ type: "text", text: "generated three reports for the client" }] } })}\n${SafeJSON.stringify({ type: "custom-title", customTitle: "report-2026-09", sessionId: deep })}\n`
    );

    // A session NAMED after the query is not the same thing as a session identified by it: one
    // captured `/resume reports-02` used to be treated as identity and buried every real match.
    writeFileSync(
        join(project, `${namesake}.jsonl`),
        `${SafeJSON.stringify({ type: "user", sessionId: namesake, cwd: "/projects/shop", message: { content: "unrelated" } })}\n${SafeJSON.stringify({ type: "custom-title", customTitle: "reports-02 rerun", sessionId: namesake })}\n`
    );

    const db = new Database(":memory:");
    try {
        const adapter = createNativeHistoryAdapter({ kind: "claude", roots: [root], database: db });
        const hits = await loadClaudeResumeCandidates({ query: "reports", cwd: "/projects/shop", adapter });

        expect(hits.map((hit) => hit.name).sort()).toEqual(["report-2026-09", "reports-02 rerun", "weekly rollup"]);

        // A name still answers on its own: no content pass, no second session dragged in.
        const named = await loadClaudeResumeCandidates({ query: "weekly rollup", cwd: "/projects/shop", adapter });

        expect(named.map((hit) => hit.name)).toEqual(["weekly rollup"]);
    } finally {
        db.close();
    }
});
