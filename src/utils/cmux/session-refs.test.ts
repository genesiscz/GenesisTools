import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as readers from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { loadAllSessionCmuxRefs, lookupSessionCmuxRefs } from "./session-refs";

const SESSION = "7a4630a0-6834-47a1-a5b5-d3b3bbae58f9";

test("historical lookup retains the pane before restart instead of a later resumed copy", () => {
    const beforeMs = Date.now() - 1000;
    const path = journal([
        entry({ surfaceId: "original", at: beforeMs - 1 }),
        entry({ surfaceId: "copy", at: beforeMs + 1 }),
    ]);
    expect(loadAllSessionCmuxRefs(path, { beforeMs }).get(SESSION)?.surfaceId).toBe("original");
});

// The journal is kept whole and read from its end; the read must not reach past the readers' 7 days.
test("the reader stops in the old part of the journal, and a stray old line does not hide the lines before it", () => {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const ancient = Array.from({ length: 200 }, (_, index) =>
        entry({ sessionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, at: now - 30 * DAY })
    );
    // A sentinel deep in the old part must never be yielded to the journal lookup.
    const path = journal([
        entry({ sessionId: "11111111-1111-4111-8111-111111111111", at: now - 40 * DAY }),
        ...ancient.slice(0, 100),
        entry({ sessionId: "deep-ancient-sentinel", at: now - 30 * DAY }),
        ...ancient.slice(100),
        entry({ surfaceId: "in-window", at: now - 2 * DAY }),
        entry({ sessionId: "22222222-2222-4222-8222-222222222222", at: now - 9 * DAY }),
        entry({ sessionId: "33333333-3333-4333-8333-333333333333", at: now - 1000 }),
    ]);

    const readBackward = readers.readLinesBackwardSync;
    const consumed: string[] = [];
    const reader = spyOn(readers, "readLinesBackwardSync").mockImplementation(function* (filePath, options) {
        for (const line of readBackward(filePath, options)) {
            consumed.push(line);
            yield line;
        }
    });

    try {
        const refs = loadAllSessionCmuxRefs(path);
        expect(refs.get(SESSION)?.surfaceId).toBe("in-window");
        expect(refs.has("33333333-3333-4333-8333-333333333333")).toBe(true);
        expect(refs.size).toBe(2);
        expect(reader).toHaveBeenCalled();
        expect(consumed.length).toBeGreaterThan(0);
        expect(consumed.length).toBeLessThan(ancient.length);
        expect(consumed.some((line) => line.includes("deep-ancient-sentinel"))).toBe(false);
    } finally {
        reader.mockRestore();
    }
});

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
    // Newest-wins means older bytes cannot change the answer, so a bound on the
    // read must not change it either.
    const filler = Array.from({ length: 4000 }, (_, i) =>
        entry({ sessionId: `old-${i}-2222-3333-4444-555555555555`, at: Date.now() - 60_000, note: "x".repeat(200) })
    );
    const path = journal([...filler, entry({ surfaceId: "surf-newest" })]);

    expect(statSync(path).size).toBeGreaterThan(512 * 1024);
    expect(lookupSessionCmuxRefs(SESSION.slice(0, 8), path)?.surfaceId).toBe("surf-newest");
});

// 2026-10-14: one busy session writes a line per prompt. Behind 512 KB of its lines, a session whose
// only record was a day old read as unrecorded, and a cmux restart could not find its tab.
test("a session whose only record sits behind 512 KB of newer lines is still found", () => {
    const busy = Array.from({ length: 4000 }, () =>
        entry({ sessionId: "b5b5b5b5-2222-4333-8444-555555555555", surfaceId: "surf-busy", note: "x".repeat(200) })
    );
    const path = journal([entry({ surfaceId: "surf-quiet", at: Date.now() - 86_400_000 }), ...busy]);

    expect(statSync(path).size).toBeGreaterThan(512 * 1024);
    expect(loadAllSessionCmuxRefs(path).get(SESSION.toLowerCase())?.surfaceId).toBe("surf-quiet");
});

// `focus`/`send` act on the tab's current occupant: once another session was recorded in the tab, or the session
// ended with /exit, its old line no longer names a target and the caller falls back to the matcher.
test("a tab another session took over, or a session ended on purpose, is not a target", () => {
    const now = Date.now();
    const takenOver = journal([
        entry({ surfaceId: "surf-1", at: now - 60_000 }),
        entry({ sessionId: "99999999-2222-3333-4444-555555555555", surfaceId: "SURF-1", at: now - 30_000 }),
    ]);
    const ended = journal([
        entry({ surfaceId: "surf-1", at: now - 60_000 }),
        entry({ surfaceId: "surf-1", ended: true }),
    ]);
    const refOnly = journal([entry({ surfaceId: null, surfaceRef: "surface:190" })]);

    expect(lookupSessionCmuxRefs(SESSION, takenOver)).toBeNull();
    expect(lookupSessionCmuxRefs(SESSION, ended)).toBeNull();
    expect(lookupSessionCmuxRefs(SESSION, refOnly)).toBeNull();
    // Control: the same session alone in its tab still resolves.
    expect(lookupSessionCmuxRefs(SESSION, journal([entry({ surfaceId: "surf-1" })]))?.surfaceId).toBe("surf-1");
});

test("journal read errors are observable without changing the default empty-map fallback", () => {
    const refsPath = journal([entry()]);
    const error = Object.assign(new Error("fixture journal permission denied"), { code: "EACCES" });
    const reader = spyOn(readers, "readLinesBackwardSync").mockImplementation(() => {
        throw error;
    });
    const failures: unknown[] = [];

    try {
        expect(loadAllSessionCmuxRefs(refsPath, { onReadError: (failure) => failures.push(failure) }).size).toBe(0);
        expect(failures).toEqual([error]);
    } finally {
        reader.mockRestore();
    }
});
