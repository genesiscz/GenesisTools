import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { appendOpenRecord, classifyTarget, type OpenRecord, openArgv, readOpenRecords } from "./opens";

const dir = mkdtempSync(join(tmpdir(), "gt-test-open-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function record(at: string, sessionId: string): OpenRecord {
    return {
        at,
        targets: [{ given: "a.md", path: join(dir, "a.md"), kind: "file" }],
        argv: ["open", join(dir, "a.md")],
        exitCode: 0,
        caller: {
            agent: "codex",
            sessionId,
            isInAgent: true,
            aiAgent: null,
            sessionTitle: null,
            project: "demo",
            repoRoot: dir,
            cwd: dir,
            isWorktree: false,
            worktreePath: null,
            branch: null,
            commitSha: null,
            commitMessage: null,
        },
    };
}

describe("tools open", () => {
    it("writes the complete caller context in each JSONL row", () => {
        const log = join(dir, "caller-shape.jsonl");
        const row = record("2026-03-01T10:00:00.000Z", "thread-1");
        appendOpenRecord(row, log);
        expect(SafeJSON.parse(readFileSync(log, "utf8"), { strict: true })).toEqual(row);
    });

    it("names each target and gives open the absolute path of a file", () => {
        writeFileSync(join(dir, "a.md"), "x");
        const targets = ["a.md", dir, "https://example.org/", "gone.txt"].map((given) => classifyTarget(given, dir));

        expect(targets.map((target) => target.kind)).toEqual(["file", "folder", "url", "missing"]);
        expect(openArgv({ targets: [], reveal: true, app: "Cursor" }, targets.slice(0, 1))).toEqual([
            "open",
            "-a",
            "Cursor",
            "-R",
            join(dir, "a.md"),
        ]);
    });

    it("reads the log newest first and filters by a session id prefix", () => {
        const log = join(dir, "opens.jsonl");
        appendOpenRecord(record("2026-03-01T10:00:00.000Z", "aaaa-1"), log);
        appendOpenRecord(record("2026-03-01T11:00:00.000Z", "bbbb-2"), log);

        expect(readOpenRecords({}, log).map((one) => one.caller.sessionId)).toEqual(["bbbb-2", "aaaa-1"]);
        expect(readOpenRecords({ sessionId: "aaaa" }, log).map((one) => one.at)).toEqual(["2026-03-01T10:00:00.000Z"]);
    });
});
