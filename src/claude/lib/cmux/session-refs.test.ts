import { expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { lookupSessionCmuxRefs } from "./session-refs";

const SESSION = "7a4630a0-6834-47a1-a5b5-d3b3bbae58f9";

function journal(lines: object[]): string {
    const dir = mkdtempSync(join(tmpdir(), "cmux-refs-"));
    const path = join(dir, "cmux-refs.jsonl");
    writeFileSync(path, `${lines.map((line) => SafeJSON.stringify(line)).join("\n")}\n`, "utf8");
    return path;
}

function entry(overrides: Record<string, unknown> = {}) {
    return {
        sessionId: SESSION,
        workspaceId: "ws-1",
        surfaceId: "surf-1",
        workspaceRef: "workspace:1",
        paneRef: "pane:35",
        surfaceRef: "surface:190",
        windowRef: "window:1",
        tmuxPane: null,
        cwd: "/repo",
        at: Date.now(),
        ...overrides,
    };
}

test("prefix lookup returns the latest line for the session", () => {
    const path = journal([
        entry({ surfaceId: "surf-old", at: Date.now() - 60_000 }),
        entry({ sessionId: "11111111-2222-3333-4444-555555555555" }),
        entry({ surfaceId: "surf-new" }),
    ]);

    expect(lookupSessionCmuxRefs(SESSION.slice(0, 8), path)?.surfaceId).toBe("surf-new");
});

test("stale entries and short prefixes return null", () => {
    const path = journal([entry({ at: Date.now() - 8 * 24 * 60 * 60 * 1000 })]);

    expect(lookupSessionCmuxRefs(SESSION.slice(0, 8), path)).toBeNull();
    expect(lookupSessionCmuxRefs(SESSION.slice(0, 6), journal([entry()]))).toBeNull();
});

test("a record with no cmux surface is not a target", () => {
    const path = journal([entry({ surfaceId: null, surfaceRef: null, tmuxPane: "%5" })]);

    expect(lookupSessionCmuxRefs(SESSION, path)).toBeNull();
});

test("a journal larger than the read cap still resolves the newest entry", () => {
    // The reader caps at 512 KB of tail. Newest-wins means older bytes cannot
    // change the answer, so the cap must not change it either.
    const filler = Array.from({ length: 4000 }, (_, i) =>
        entry({ sessionId: `old-${i}-2222-3333-4444-555555555555`, at: Date.now() - 60_000, note: "x".repeat(200) })
    );
    const path = journal([...filler, entry({ surfaceId: "surf-newest" })]);

    expect(statSync(path).size).toBeGreaterThan(512 * 1024);
    expect(lookupSessionCmuxRefs(SESSION.slice(0, 8), path)?.surfaceId).toBe("surf-newest");
});
