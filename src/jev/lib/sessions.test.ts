import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressFile } from "@genesiscz/utils/compress/file";
import {
    basePid,
    countByStatus,
    decisionsOf,
    errorsOf,
    groupSessions,
    type JevLogRow,
    logDays,
    parseLogLine,
    readSessions,
    transcriptOf,
} from "./sessions";

const BASE = `"hostname":"host","component":"jev-listen"`;

function line(pid: number, time: string, msg: string, extra = ""): string {
    return `{"level":30,"time":"${time}","pid":${pid},${BASE}${extra},"msg":"${msg}"}`;
}

describe("jev session log reader", () => {
    test("the emitting pid is read from pino's base position, not from a payload field of the same name", () => {
        const collides = line(9716, "2026-09-18T21:52:57.600Z", "native see ok", `,"app":"ChatGPT","pid":40944`);
        expect(basePid(collides)).toBe(9716);
        expect(parseLogLine(collides)?.pid).toBe(9716);
        expect(parseLogLine(collides)?.app).toBe("ChatGPT");
    });

    test("parseLogLine rejects anything that is not a pino row", () => {
        expect(parseLogLine("")).toBeNull();
        expect(parseLogLine("mic: streaming 16000 Hz")).toBeNull();
        expect(parseLogLine('{"level":30,"msg":"no pid"}')).toBeNull();
        expect(parseLogLine('{"level":30,"time":"t","pid":1,"hostname":"h"}')).toBeNull();
    });

    test("a session runs from its start row to that pid's last row, and other pids do not leak in", () => {
        const rows = [
            line(10, "2026-09-18T21:00:00.000Z", "jev listen starting", `,"app":"Calculator","provider":"deepgram"`),
            line(11, "2026-09-18T21:00:01.000Z", "something else entirely"),
            line(10, "2026-09-18T21:00:02.000Z", "listen decision", `,"status":"act","transcript":"Press 7."`),
            line(12, "2026-09-18T21:00:03.000Z", "jev loop starting", `,"app":"Brave"`),
            line(10, "2026-09-18T21:00:04.000Z", "audio pump finished"),
        ].map((raw) => parseLogLine(raw) as JevLogRow);

        const sessions = groupSessions(rows, "2026-09-18");
        expect(sessions.map((session) => [session.pid, session.command])).toEqual([
            [10, "listen"],
            [12, "loop"],
        ]);
        expect(sessions[0].app).toBe("Calculator");
        expect(sessions[0].rows).toHaveLength(3);
        expect(sessions[0].endedAt).toBe("2026-09-18T21:00:04.000Z");
        expect(sessions[1].rows).toHaveLength(1);
    });

    test("the transcript keeps what was said in order and drops the repeats and the empty holds", () => {
        const rows = [
            line(10, "2026-09-18T21:00:00.000Z", "jev listen starting"),
            line(10, "2026-09-18T21:00:01.000Z", "listen decision", `,"status":"hold","transcript":""`),
            line(10, "2026-09-18T21:00:02.000Z", "listen decision", `,"status":"would","transcript":"Press"`),
            line(10, "2026-09-18T21:00:03.000Z", "listen decision", `,"status":"abstain","transcript":"Press 7."`),
            line(10, "2026-09-18T21:00:04.000Z", "listen decision", `,"status":"abstain","transcript":"Press 7."`),
        ].map((raw) => parseLogLine(raw) as JevLogRow);

        const session = groupSessions(rows, "2026-09-18")[0];
        expect(transcriptOf(session)).toEqual(["Press", "Press 7."]);
        expect(countByStatus(decisionsOf(session))).toEqual({ hold: 1, would: 1, abstain: 2 });
    });

    test("errors are collected from warn level upwards with their message", () => {
        const rows = [
            line(10, "2026-09-18T21:00:00.000Z", "jev listen starting"),
            `{"level":50,"time":"2026-09-18T21:00:01.000Z","pid":10,"hostname":"h","error":{"message":"AX tree exceeds --depth 20"},"msg":"jev command failed"}`,
            line(10, "2026-09-18T21:00:02.000Z", "listen decision", `,"status":"hold","transcript":""`),
        ].map((raw) => parseLogLine(raw) as JevLogRow);

        const session = groupSessions(rows, "2026-09-18")[0];
        expect(errorsOf(session)).toEqual([
            { time: "2026-09-18T21:00:01.000Z", msg: "jev command failed", error: "AX tree exceeds --depth 20" },
        ]);
    });
});
describe("jev sessions across compressed day logs", () => {
    test("an older day stored as .log.zst is listed and read like a plain one", async () => {
        const dir = mkdtempSync(join(tmpdir(), "jev-days-"));

        try {
            const rows = [
                line(
                    10,
                    "2026-09-17T21:00:00.000Z",
                    "jev listen starting",
                    `,"app":"Calculator","provider":"deepgram"`
                ),
                line(10, "2026-09-17T21:00:02.000Z", "listen decision", `,"status":"act","transcript":"Press 7."`),
            ].join("\n");
            writeFileSync(join(dir, "2026-09-18.log"), rows);
            writeFileSync(join(dir, "2026-09-17.log"), rows);
            await compressFile({ source: join(dir, "2026-09-17.log") });
            rmSync(join(dir, "2026-09-17.log"));
            writeFileSync(join(dir, "2026-09-17-profiling.log"), "not a day log\n");

            expect(logDays(dir)).toEqual(["2026-09-18", "2026-09-17"]);
            const [plain, compressed] = [await readSessions("2026-09-18", dir), await readSessions("2026-09-17", dir)];
            expect(compressed).toHaveLength(1);
            expect(compressed).toEqual(plain.map((session) => ({ ...session, day: "2026-09-17" })));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
