import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    bashWritesOf,
    type ChangeLogRow,
    changeLogPath,
    parseChangeLogRow,
    readChangeLog,
    WALK_CHUNK_BYTES,
    walkChangeLogs,
} from "./change-log";

/**
 * Appends one row as the hook's writer (`recordChange` in `src/agents/lib/changes/log.ts`) writes it. utils may not
 * import the agents tool, so the writer-to-reader round trip itself is tested in `log.test.ts`.
 */
function append(session: string, path: string, source: ChangeLogRow["source"], ts: string, began?: string): void {
    const row: ChangeLogRow = {
        ts,
        provider: "claude",
        session,
        turn: "t1",
        tool: source === "bash" ? "Bash" : "Edit",
        cwd: "/w",
        path,
        source,
        ...(began ? { began } : {}),
        beforeOid: null,
        afterOid: `oid-${path}`,
    };
    const file = changeLogPath(session);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${SafeJSON.stringify(row)}\n`);
}

/** A fresh genesis-tools root for one test: every path the module builds lands inside it. */
async function inTempRoot(run: () => void): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), "change-log-"));
    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, run);
}

/** Sets the log's mtime, which orders the walk and decides `since`. */
function touch(session: string, epochSeconds: number): void {
    utimesSync(changeLogPath(session), epochSeconds, epochSeconds);
}

describe("the change log read side", () => {
    test("reads back one session's rows as the writer appended them, and nothing for a session without a log", async () => {
        await inTempRoot(() => {
            append("alpha", "/w/a.ts", "edit", "2026-11-01T10:00:00.000Z");
            append("alpha", "/w/b.txt", "bash", "2026-11-01T10:01:00.000Z", "2026-11-01T10:00:59.000Z");

            expect(readChangeLog("alpha")).toEqual([
                expect.objectContaining({ path: "/w/a.ts", source: "edit", afterOid: "oid-/w/a.ts", beforeOid: null }),
                expect.objectContaining({ path: "/w/b.txt", source: "bash", began: "2026-11-01T10:00:59.000Z" }),
            ]);
            expect(readChangeLog("no-such-session")).toEqual([]);
            expect(() => changeLogPath("../escape")).toThrow(/not a session id/);
        });
    });

    test("walks every session folder, a session id that starts with _ included, the newest log first", async () => {
        await inTempRoot(() => {
            append("old", "/w/old.ts", "edit", "2026-10-01T10:00:00.000Z");
            append("_underscored", "/w/u.ts", "edit", "2026-11-01T10:00:00.000Z");
            append("new", "/w/new.ts", "edit", "2026-11-02T10:00:00.000Z");
            touch("old", 1_000);
            touch("_underscored", 2_000);
            touch("new", 3_000);
            // A folder with no change log (the object store's) is skipped, not an error.
            mkdirSync(join(changeLogPath("old"), "..", "..", "_objects"), { recursive: true });

            expect([...walkChangeLogs()].map((entry) => entry.sessionId)).toEqual(["new", "_underscored", "old"]);
        });
    });

    test("since skips logs written before it; maxSessions keeps the newest logs; maxRows stops the walk", async () => {
        await inTempRoot(() => {
            append("old", "/w/old.ts", "edit", "2026-10-01T10:00:00.000Z");
            append("mid", "/w/m1.ts", "edit", "2026-11-01T10:00:00.000Z");
            append("mid", "/w/m2.ts", "edit", "2026-11-01T10:01:00.000Z");
            append("new", "/w/n1.ts", "edit", "2026-11-02T10:00:00.000Z");
            append("new", "/w/n2.ts", "edit", "2026-11-02T10:01:00.000Z");
            touch("old", 1_000);
            touch("mid", 2_000);
            touch("new", 3_000);

            const sessions = (options: Parameters<typeof walkChangeLogs>[0]) =>
                [...walkChangeLogs(options)].map((entry) => [entry.sessionId, entry.rows.map((row) => row.path)]);

            expect(sessions({ since: 2_000_000 })).toEqual([
                ["new", ["/w/n1.ts", "/w/n2.ts"]],
                ["mid", ["/w/m1.ts", "/w/m2.ts"]],
            ]);
            expect(sessions({ maxSessions: 1 })).toEqual([["new", ["/w/n1.ts", "/w/n2.ts"]]]);
            expect(sessions({ maxRows: 3 })).toEqual([
                ["new", ["/w/n1.ts", "/w/n2.ts"]],
                ["mid", ["/w/m1.ts"]],
            ]);
        });
    });

    test("reads a log in chunks: a row across a chunk edge comes back whole, and the rest is read only while rows are due", async () => {
        await inTempRoot(() => {
            const rows = Math.ceil((3 * WALK_CHUNK_BYTES) / 200);

            for (let index = 0; index < rows; index++) {
                append("big", `/w/f${String(index).padStart(5, "0")}.ts`, "edit", "2026-11-01T10:00:00.000Z");
            }

            append("big", "/w/late-a.ts", "edit", "2026-11-01T11:00:00.000Z");
            const path = changeLogPath("big");
            const body = readFileSync(path, "utf8");
            expect(body.length).toBeGreaterThan(2 * WALK_CHUNK_BYTES);

            const all = [...walkChangeLogs()].flatMap((entry) => entry.rows.map((row) => row.path));
            expect(all).toHaveLength(rows + 1);
            expect(all.slice(0, 2)).toEqual(["/w/f00000.ts", "/w/f00001.ts"]);
            expect(all.at(-1)).toBe("/w/late-a.ts");

            const capped = [...walkChangeLogs({ maxRows: 5 })].flatMap((entry) => entry.rows.map((row) => row.path));
            expect(capped).toEqual(["/w/f00000.ts", "/w/f00001.ts", "/w/f00002.ts", "/w/f00003.ts", "/w/f00004.ts"]);

            // The log is not loaded up front: the tail is rewritten while the walk gates its first line, and the walk
            // returns the rewritten row. A walk that read the whole log first would still return the old one.
            let rewritten = false;
            const late = [
                ...walkChangeLogs({
                    keepLine: (line) => {
                        if (!rewritten) {
                            rewritten = true;
                            writeFileSync(path, body.replace("/w/late-a.ts", "/w/late-b.ts"));
                        }

                        return line.includes("/w/late-");
                    },
                }),
            ].flatMap((entry) => entry.rows.map((row) => row.path));
            expect(late).toEqual(["/w/late-b.ts"]);
        });
    });

    test("lists one path's Bash writes in log order; an Edit row, another path or a torn line gives none", async () => {
        await inTempRoot(() => {
            append("bash", "/w/made.txt", "bash", "2026-11-01T10:00:00.000Z");
            append("bash", "/w/made.txt", "edit", "2026-11-01T10:01:00.000Z");
            append("bash", "/w/made.txt", "bash", "2026-11-01T10:05:00.000Z", "2026-11-01T10:04:58.000Z");
            writeFileSync(changeLogPath("bash"), '{ "source":"bash", torn\n', { flag: "a" });

            expect(bashWritesOf("bash", "/w/made.txt").map((row) => [row.ts, row.began ?? null])).toEqual([
                ["2026-11-01T10:00:00.000Z", null],
                ["2026-11-01T10:05:00.000Z", "2026-11-01T10:04:58.000Z"],
            ]);
            expect(bashWritesOf("bash", "/w/other.txt")).toEqual([]);
            expect(bashWritesOf("../escape", "/w/made.txt")).toEqual([]);
        });
    });

    test("a value without ts, session, path or a known source is not a row", () => {
        const base = { ts: "2026-11-01T10:00:00.000Z", session: "s", path: "/w/a", source: "edit" };

        expect(parseChangeLogRow(base)).toMatchObject({ ...base, provider: "", beforeOid: null, afterOid: null });

        for (const broken of [
            { ...base, ts: undefined },
            { ...base, session: 7 },
            { ...base, path: null },
            { ...base, source: "copy" },
            { ...base, beforeOid: 3 },
        ]) {
            expect(parseChangeLogRow(SafeJSON.parse(SafeJSON.stringify(broken)))).toBeNull();
        }
    });
});
