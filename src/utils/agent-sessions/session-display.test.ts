import { expect, test } from "bun:test";
import { buildSessionTableOpts, toSessionDisplay } from "./session-display";
import type { AgentSearchHit, AgentSession } from "./types";

/**
 * The rows every coding-agent session table and picker is built from.
 *
 * This file and its mapper were `utils/claude/session-display.ts` plus a private copy inside
 * `claude/commands/resume.ts`. Codex and grok resumed through a one-line `p.select` instead,
 * which shows a hint only for the focused row, so two sessions that differ by project or branch
 * looked identical. Both doors now render from here.
 */

const session = (over: Partial<AgentSession> = {}): AgentSession => ({
    kind: "codex",
    sessionId: "aaaa1111-2222-4333-8444-555555555555",
    title: "Invoice import",
    cwd: "/work/shop",
    mtime: new Date("2026-09-01T10:00:00Z"),
    filePath: "/sessions/aaaa1111.jsonl",
    ...over,
});

test("a plain session maps to a cache row and a search hit carries its snippet", () => {
    expect(toSessionDisplay(session()).source).toBe("cache");

    const hit: AgentSearchHit = { ...session(), matchedText: "the invoice totals" };
    const row = toSessionDisplay(hit);

    expect(row.source).toBe("search");
    expect(row.matchSnippet).toBe("the invoice totals");
});

test("the row name falls back title, summary, prompt, then says so", () => {
    expect(toSessionDisplay(session()).name).toBe("Invoice import");
    expect(toSessionDisplay(session({ title: "", summary: "Import run" })).name).toBe("Import run");
    expect(toSessionDisplay(session({ title: "", prompt: "import the invoices" })).name).toBe("import the invoices");
    expect(toSessionDisplay(session({ title: "" })).name).toBe("(unnamed)");
});

test("the encoded transcript directory fills PROJECT while the friendly name is kept beside it", () => {
    const row = toSessionDisplay(session({ project: "shop", projectDirectory: "-work-shop" }));

    expect(row.project).toBe("-work-shop");
    expect(row.projectName).toBe("shop");
});

test("a picker row names the home and file a copy came from, and omits both when unknown", () => {
    // The same session id is indexed once per home it was copied into. The row itself cannot
    // tell those copies apart, so resuming one of them offers to import a session the launch
    // home already holds.
    const withSource = buildSessionTableOpts([toSessionDisplay(session({ sourceHome: "/old-home" }))], {
        message: "Resume which codex session?",
    });
    const detail = withSource.rows[0].detail?.join("\n") ?? "";

    expect(detail).toContain("Source home: /old-home");
    expect(detail).toContain("Source file: /sessions/aaaa1111.jsonl");

    const plain = toSessionDisplay(session());
    plain.sourceHome = undefined;
    plain.filePath = undefined;
    const without = buildSessionTableOpts([plain], { message: "Resume which codex session?" });

    expect(without.rows[0].detail?.join("\n") ?? "").not.toContain("Source home");
});

test("the picker gains a PROJECT column only when the candidates span several projects", () => {
    const shop = toSessionDisplay(session({ project: "shop", projectDirectory: "-work-shop" }));
    const other = toSessionDisplay(session({ project: "other", projectDirectory: "-work-other" }));
    const one = buildSessionTableOpts([shop], { message: "pick" });
    const two = buildSessionTableOpts([shop, other], { message: "pick" });

    expect(one.columns.map((column) => column.label)).not.toContain("PROJECT");
    expect(two.columns.map((column) => column.label)).toContain("PROJECT");
});
