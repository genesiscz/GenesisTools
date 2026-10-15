import { describe, expect, test } from "bun:test";
import {
    appendFileSync,
    closeSync,
    existsSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactJournal, planJournalCompaction } from "@app/cmux/lib/journal-compact";
import { loadSurfaceSessions } from "@app/cmux/lib/surface-sessions";
import { loadAllSessionCmuxRefs, lookupSessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import { SafeJSON } from "@genesiscz/utils/json";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const CLAUDE = "7a4630a0-6834-47a1-a5b5-d3b3bbae58f9";
const WORKER = "aaaaaaaa-1111-4111-8111-111111111111";
const CODEX = "0198f2a1-7b3c-7d00-8000-0000000000c1";
const GROK = "0198f2a1-7b3c-7d00-8000-0000000000d1";
const OLD = "bbbbbbbb-2222-4222-8222-222222222222";
const MOVER = "cccccccc-3333-4333-8333-333333333333";

function sandbox(): { dir: string; path: string; pinsPath: string; aside: string } {
    const dir = mkdtempSync(join(tmpdir(), "cmux-journal-compact-"));
    const pinsPath = join(dir, "session-pins.jsonl");
    writeFileSync(pinsPath, "");

    return { dir, path: join(dir, "cmux-refs.jsonl"), pinsPath, aside: join(dir, "aside") };
}

function entry(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        sessionId: CLAUDE,
        workspaceId: "ws-1",
        surfaceId: "surf-a",
        workspaceRef: "workspace:1",
        paneRef: "pane:1",
        surfaceRef: "surface:1",
        windowRef: "window:1",
        tmuxPane: null,
        cwd: "/repo",
        ...overrides,
    };
}

function text(lines: Record<string, unknown>[]): string {
    return `${lines.map((line) => SafeJSON.stringify(line)).join("\n")}\n`;
}

/**
 * Several sessions on several surfaces and providers, each with many middle lines: a Claude tab with a worker
 * started inside it, a Codex and a Grok tab (one ended on purpose and resumed), a session that moved to another
 * tab, a session older than the window, lines with unusual case, and a timestamp tie.
 */
function fixture(now: number): Record<string, unknown>[] {
    const lines: Record<string, unknown>[] = [];
    const add = (sessionId: string, surfaceId: string | null, agoMs: number, extra: Record<string, unknown> = {}) =>
        lines.push(entry({ sessionId, surfaceId, at: now - agoMs, ...extra }));

    for (const [index, ago] of [
        6.5 * DAY,
        5 * DAY,
        3 * DAY,
        2 * DAY,
        30 * HOUR,
        26 * HOUR,
        12 * HOUR,
        HOUR,
    ].entries()) {
        add(CLAUDE, "SURF-A", ago, { cwd: `/repo/step-${index}`, surfaceRef: `surface:${index}` });
    }

    add(WORKER, "surf-a", 2 * DAY, { provider: "codex" });
    add(WORKER, "surf-a", 40 * HOUR, { provider: "codex" });
    add(WORKER, "surf-a", 2 * HOUR, { provider: "codex" });

    for (const ago of [6 * DAY, 4 * DAY, 3 * DAY, 90 * HOUR]) {
        add(CODEX, "surf-b", ago, { provider: "codex", cwd: `/codex/${ago}` });
    }

    add(GROK, "surf-c", 5 * DAY, { provider: "grok" });
    add(GROK, "surf-c", 4.5 * DAY, { provider: "grok", ended: true });
    add(GROK, "surf-c", 4 * DAY, { provider: "grok" });
    add(GROK, "surf-c", 3 * DAY, { provider: "grok" });

    for (const ago of [9 * DAY, 8.5 * DAY, 8 * DAY]) {
        add(OLD, "surf-old", ago);
    }

    add(MOVER, "surf-a", 6 * DAY);
    add(MOVER, "surf-a", 5 * DAY);
    add(MOVER, "surf-b", 4 * DAY);
    add(MOVER, "surf-b", 3 * DAY);
    add(MOVER, "surf-b", 2.5 * DAY);

    // Same `at`: the later line in the file is the one the readers pick.
    add(CODEX, "surf-b", 2 * DAY, { provider: "codex", cwd: "/codex/tie-first" });
    add(CODEX, "surf-b", 2 * DAY, { provider: "codex", cwd: "/codex/tie-second" });

    return lines;
}

function readersSnapshot(path: string): Record<string, unknown> {
    const all = loadAllSessionCmuxRefs(path);

    return {
        all: [...all.entries()].sort(([a], [b]) => a.localeCompare(b)),
        lookup: [CLAUDE, WORKER, CODEX, GROK, MOVER, OLD].map((id) => lookupSessionCmuxRefs(id.slice(0, 8), path)),
    };
}

describe("planJournalCompaction", () => {
    test("keeps the first and last line of a session on a surface, the end marks and the last day", () => {
        const now = 1_800_000_000_000;
        const at = (days: number) => now - days * DAY;
        const lines = [6.9, 6, 5, 4, 3, 2, 0.5, 0.1].map((days) => entry({ at: at(days), ended: days === 4 }));
        lines.push(entry({ at: at(8) }));
        const body = `${text(lines)}this line is not json\n`;

        const { text: kept, stats } = planJournalCompaction(body, now);

        expect(
            kept
                .trim()
                .split("\n")
                .map((line) => (SafeJSON.parse(line) as { at: number }).at)
        ).toEqual([at(6.9), at(4), at(0.5), at(0.1)]);
        expect(stats).toMatchObject({
            linesBefore: 10,
            linesAfter: 4,
            dropped: { aged: 1, redundant: 4, unreadable: 1 },
        });
        expect(stats.bytesAfter).toBe(Buffer.byteLength(kept));
    });

    test("tells groups apart by session, surface and provider, ignoring case", () => {
        const now = 1_800_000_000_000;
        const lines = [
            entry({ sessionId: "AAAAAAAA-1111-4111-8111-111111111111", surfaceId: "S1", at: now - 5 * DAY }),
            entry({ sessionId: "aaaaaaaa-1111-4111-8111-111111111111", surfaceId: "s1", at: now - 4 * DAY }),
            entry({ sessionId: "aaaaaaaa-1111-4111-8111-111111111111", surfaceId: "s1", at: now - 3 * DAY }),
            entry({ sessionId: "aaaaaaaa-1111-4111-8111-111111111111", surfaceId: "s2", at: now - 4 * DAY }),
            entry({ sessionId: "aaaaaaaa-1111-4111-8111-111111111111", surfaceId: "s2", at: now - 3 * DAY }),
        ];

        // s1: first and last of one group (middle dropped); s2: first and last too.
        expect(planJournalCompaction(text(lines), now).stats).toMatchObject({ linesBefore: 5, linesAfter: 4 });
    });
});

describe("compactJournal", () => {
    test("every reader answers the same after the compaction", async () => {
        const now = Date.now();
        const { path, pinsPath, aside } = sandbox();
        writeFileSync(path, text(fixture(now)));

        const before = readersSnapshot(path);
        const surfacesBefore = await loadSurfaceSessions({ refsPath: path, pinsPath });
        const result = compactJournal({ path, now, asideDir: aside });
        const surfacesAfter = await loadSurfaceSessions({ refsPath: path, pinsPath });

        // The fixture must actually exercise the rules, or equality proves nothing.
        expect(result.changed).toBe(true);
        expect(result.linesAfter).toBeLessThan(result.linesBefore - 10);
        expect(result.dropped.aged).toBeGreaterThan(0);
        expect(result.dropped.redundant).toBeGreaterThan(0);
        expect(surfacesBefore.get("surf-a")?.candidates?.length).toBe(2);
        expect(surfacesBefore.get("surf-a")?.firstAt).toBeDefined();

        expect(readersSnapshot(path)).toEqual(before);
        expect(surfacesAfter).toEqual(surfacesBefore);
        // A session that was ended on purpose and resumed, and the timestamp tie, come out as before.
        expect(loadAllSessionCmuxRefs(path).get(CODEX)?.cwd).toBe("/codex/tie-second");
        expect(loadAllSessionCmuxRefs(path).has(OLD)).toBe(false);
    });

    test("a dry run reports the counts and writes nothing", () => {
        const now = Date.now();
        const { dir, path, aside } = sandbox();
        writeFileSync(path, text(fixture(now)));
        const bytes = readFileSync(path);

        const result = compactJournal({ path, now, dryRun: true, asideDir: aside });

        expect(result).toMatchObject({ dryRun: true, changed: true, backupPath: null, movedBackups: [] });
        expect(result.linesAfter).toBeLessThan(result.linesBefore);
        expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
        expect(readFileSync(path).equals(bytes)).toBe(true);
        expect(readdirSync(dir).filter((name) => name.endsWith(".bak"))).toEqual([]);
    });

    test("a journal with nothing to drop is left alone, with no backup", () => {
        const now = Date.now();
        const { dir, path } = sandbox();
        writeFileSync(path, text([entry({ at: now - HOUR }), entry({ sessionId: GROK, at: now - 2 * HOUR })]));
        const before = statSync(path);

        const result = compactJournal({ path, now });

        expect(result).toMatchObject({ changed: false, backupPath: null, linesBefore: 2, linesAfter: 2 });
        expect(statSync(path).ino).toBe(before.ino);
        expect(readdirSync(dir).filter((name) => name.endsWith(".bak"))).toEqual([]);
    });

    test("a missing journal is reported as empty", () => {
        const { path } = sandbox();

        expect(compactJournal({ path })).toMatchObject({ changed: false, linesBefore: 0, bytesBefore: 0 });
    });

    test("lines appended after the read, and the end of a line still being written, are carried over", () => {
        const now = Date.now();
        const { path, aside } = sandbox();
        const lateLine = entry({ sessionId: GROK, surfaceId: "surf-late", at: now });
        const afterRename = entry({ sessionId: CODEX, surfaceId: "surf-after", at: now });
        const half = SafeJSON.stringify(entry({ sessionId: MOVER, surfaceId: "surf-half", at: now }));
        const split = Math.floor(half.length / 2);
        writeFileSync(path, `${text(fixture(now))}${half.slice(0, split)}`);

        const result = compactJournal({
            path,
            now,
            asideDir: aside,
            onRead: () => appendFileSync(path, `${half.slice(split)}\n${SafeJSON.stringify(lateLine)}\n`),
            onRenamed: () => appendFileSync(path, `${SafeJSON.stringify(afterRename)}\n`),
        });

        const lines = readFileSync(path, "utf8").trim().split("\n");
        const parsed = lines.map((line) => SafeJSON.parse(line) as { surfaceId: string });

        expect(parsed.filter((line) => line.surfaceId === "surf-half")).toHaveLength(1);
        expect(parsed.filter((line) => line.surfaceId === "surf-late")).toHaveLength(1);
        // A hook that opens the journal by path after the rename appends to the new file.
        expect(parsed.filter((line) => line.surfaceId === "surf-after")).toHaveLength(1);
        expect(result.carriedBytes).toBeGreaterThan(0);
    });

    test("a line a hook appends to the old file after the rename is carried too", () => {
        const now = Date.now();
        const { path, aside } = sandbox();
        const late = SafeJSON.stringify(entry({ sessionId: GROK, surfaceId: "surf-open", at: now }));
        writeFileSync(path, text(fixture(now)));

        // The hook opened the file before the rename and appends to that file after it: the path no longer leads there.
        const hookFd = openSync(path, "a");
        compactJournal({ path, now, asideDir: aside, onRenamed: () => writeSync(hookFd, `${late}\n`) });
        closeSync(hookFd);

        const surfaces = readFileSync(path, "utf8")
            .trim()
            .split("\n")
            .map((line) => (SafeJSON.parse(line) as { surfaceId: string }).surfaceId);
        expect(surfaces.filter((id) => id === "surf-open")).toHaveLength(1);
    });

    test("a journal replaced by another compaction is not overwritten", () => {
        const now = Date.now();
        const { dir, path } = sandbox();
        writeFileSync(path, text(fixture(now)));
        const other = join(dir, "other.jsonl");
        writeFileSync(other, text([entry({ sessionId: GROK, at: now })]));

        expect(() =>
            compactJournal({ path, now, asideDir: join(dir, "aside"), onRead: () => renameSync(other, path) })
        ).toThrow(/was replaced while it was compacted/);
        expect(readFileSync(path, "utf8")).toBe(text([entry({ sessionId: GROK, at: now })]));
    });

    test("keeps the original as the newest .bak and moves older backups aside instead of deleting them", () => {
        const now = Date.now();
        const { dir, path, aside } = sandbox();
        const original = text(fixture(now));
        writeFileSync(path, original);
        const older = join(dir, "cmux-refs.jsonl.20260101-000000.bak");
        writeFileSync(older, "an earlier journal\n");

        const result = compactJournal({ path, now, asideDir: aside });

        expect(result.backupPath).toMatch(/cmux-refs\.jsonl\.\d{8}-\d{6}\.bak$/);
        expect(readFileSync(result.backupPath ?? "", "utf8")).toBe(original);
        expect(readdirSync(dir).filter((name) => name.endsWith(".bak"))).toEqual([
            (result.backupPath ?? "").split("/").pop() ?? "",
        ]);
        expect(existsSync(older)).toBe(false);
        expect(result.movedBackups).toEqual([join(aside, "cmux-refs.jsonl.20260101-000000.bak")]);
        expect(readFileSync(join(aside, "cmux-refs.jsonl.20260101-000000.bak"), "utf8")).toBe("an earlier journal\n");
    });

    test("the rewritten journal keeps the mode of the old one", () => {
        const now = Date.now();
        const { path, aside } = sandbox();
        writeFileSync(path, text(fixture(now)), { mode: 0o640 });

        compactJournal({ path, now, asideDir: aside });

        expect(statSync(path).mode & 0o777).toBe(0o640);
    });
});
