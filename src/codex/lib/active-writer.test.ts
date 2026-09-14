import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenFilesResult } from "@genesiscz/utils/process/open-files";
import { formatActiveWriter, inspectActiveWriter, isActiveWriterError, threadLockPath } from "./active-writer";

const THREAD = "01a08283-d374-7ab3-bcc5-72f83340a153";

function home(): string {
    const root = mkdtempSync(join(tmpdir(), "codex-active-writer-"));
    mkdirSync(join(root, "thread-writer-locks"), { recursive: true });
    writeFileSync(threadLockPath(root, THREAD), "");
    return root;
}

const held = (): OpenFilesResult => [{ pid: 31281, command: "codex", path: "lock" }];
const free = (): OpenFilesResult => [];
const unanswerable = (): OpenFilesResult => "unknown";

describe("isActiveWriterError", () => {
    test("matches only the app-server's writer refusal", () => {
        expect(isActiveWriterError(new Error(`thread ${THREAD} already has an active writer`))).toBe(true);
        expect(isActiveWriterError(new Error("thread/resume failed: no such thread"))).toBe(false);
        expect(isActiveWriterError("already has an active writer")).toBe(false);
    });
});

describe("inspectActiveWriter", () => {
    test("names the holder and the thread's last message", () => {
        const root = home();
        const rollout = join(root, "rollout.jsonl");
        writeFileSync(rollout, "{}\n");

        const report = inspectActiveWriter({
            home: root,
            threadId: THREAD,
            rolloutPath: rollout,
            inspectOpenFiles: held,
            describeProcess: () => ({ cwd: "/projects/shop", startedAt: "Thu Sep 10 20:24:54 2026" }),
        });

        expect(report.holders).toEqual([
            { pid: 31281, command: "codex", cwd: "/projects/shop", startedAt: "Thu Sep 10 20:24:54 2026" },
        ]);
        expect(report.lastActivity).toBeInstanceOf(Date);

        const text = formatActiveWriter(report, "tools codex run work").join("\n");

        expect(text).toContain("codex (pid 31281)");
        expect(text).toContain("kill 31281");
        expect(text).toContain("tools codex run work");
    });

    test("a free lock reads as a stale refusal, not as a holder", () => {
        const root = home();
        const report = inspectActiveWriter({ home: root, threadId: THREAD, inspectOpenFiles: free });

        expect(report.holders).toEqual([]);

        const text = formatActiveWriter(report).join("\n");

        expect(text).toContain("free now");
        expect(text).not.toContain("kill ");
    });

    test("an unanswerable lsof is never reported as an empty lock", () => {
        const root = home();
        const report = inspectActiveWriter({ home: root, threadId: THREAD, inspectOpenFiles: unanswerable });

        expect(report.holders).toBeUndefined();

        const text = formatActiveWriter(report).join("\n");

        expect(text).toContain("could tell");
        expect(text).not.toContain("free now");
    });
});
