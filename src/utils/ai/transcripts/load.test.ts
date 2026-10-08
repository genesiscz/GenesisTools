import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { codexNativeLinesToTurns, createCodexTurnParser } from "./codex";
import { transcriptEnvelope, transcriptSnapshot } from "./load";
import { readRecordsAppendOnly } from "./record-cache";
import type { ResolvedTranscript } from "./resolve";
import { foldTurnsAppendOnly } from "./turn-fold-cache";

function fixtureRoot(): string {
    return mkdtempSync(join(tmpdir(), "gt-load-"));
}

describe("transcriptEnvelope", () => {
    test("one native snapshot drains all pages with one read and refreshes on the next drain", async () => {
        const file = join(fixtureRoot(), "native.jsonl");
        const rows = Array.from({ length: 2001 }, (_, i) =>
            SafeJSON.stringify({
                type: "response_item",
                timestamp: "2026-09-01T10:00:00.000Z",
                payload: {
                    type: "message",
                    role: i % 2 ? "assistant" : "user",
                    content: [{ type: i % 2 ? "output_text" : "input_text", text: String(i) }],
                },
            })
        );
        writeFileSync(file, `${rows.join("\n")}\n`);
        const resolved: ResolvedTranscript = {
            provider: "codex",
            source: "native",
            sessionId: "fixture",
            filePath: file,
        };
        // One open of the file per snapshot: records are read through `readRecordsAppendOnly`.
        const reader = spyOn(fs, "openSync");
        try {
            const page = await transcriptSnapshot(resolved);
            const all = [
                page({ offset: 0, limit: 1000 }),
                page({ offset: 1000, limit: 1000 }),
                page({ offset: 2000, limit: 1000 }),
            ];
            expect(reader.mock.calls.filter(([path]) => path === file)).toHaveLength(1);
            expect(all.flatMap((item) => item.turns).map((turn) => turn.text)).toEqual(rows.map((_, i) => String(i)));
            expect(all.map((item) => item.nextOffset)).toEqual([1000, 2000, 2001]);
            writeFileSync(file, `${rows[0]}\n`);
            expect(page().turnCount).toBe(2001);
            expect((await transcriptSnapshot(resolved))().turnCount).toBe(1);
        } finally {
            reader.mockRestore();
        }
    });

    test("loads grok native ACP updates into assistant turns", async () => {
        const root = fixtureRoot();
        const file = join(root, "updates.jsonl");
        writeFileSync(
            file,
            [
                SafeJSON.stringify({
                    timestamp: 1_700_000_000,
                    params: {
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: "listing" },
                        },
                    },
                }),
                SafeJSON.stringify({
                    timestamp: 1_700_000_001,
                    params: { update: { sessionUpdate: "turn_completed" } },
                }),
            ].join("\n")
        );
        const resolved: ResolvedTranscript = {
            provider: "grok",
            source: "native",
            sessionId: "sess",
            filePath: file,
        };
        const envelope = await transcriptEnvelope(resolved);
        expect(envelope.provider).toBe("grok");
        expect(envelope.turns[0]?.text).toBe("listing");
        expect(envelope.filePath).toBe(file);
        expect(envelope.byteSize).toBeGreaterThan(0);
    });

    test("skips malformed JSONL in the loader, not only in converters", async () => {
        const root = fixtureRoot();
        const file = join(root, "updates.jsonl");
        writeFileSync(
            file,
            [
                "not json",
                '{"params":',
                SafeJSON.stringify({
                    timestamp: 1_700_000_000,
                    params: {
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: "ok" },
                        },
                    },
                }),
                SafeJSON.stringify({
                    timestamp: 1_700_000_001,
                    params: { update: { sessionUpdate: "turn_completed" } },
                }),
            ].join("\n")
        );
        const envelope = await transcriptEnvelope({
            provider: "grok",
            source: "native",
            sessionId: "sess",
            filePath: file,
        });
        expect(envelope.turns[0]?.text).toBe("ok");
    });

    test("loads codex GT events and native rollout lines", async () => {
        const root = fixtureRoot();
        mkdirSync(root, { recursive: true });
        const gtFile = join(root, "gt.jsonl");
        writeFileSync(
            gtFile,
            `${SafeJSON.stringify({
                seq: 1,
                ts: "2026-08-27T20:00:00.000Z",
                source: "app-server",
                method: "item/agentMessage/delta",
                params: { delta: "from gt" },
            })}\n`
        );
        const gt = await transcriptEnvelope({
            provider: "codex",
            source: "worker",
            sessionId: "gt",
            filePath: gtFile,
        });
        expect(gt.turns[0]?.text).toContain("from gt");

        const nativeFile = join(root, "native.jsonl");
        writeFileSync(
            nativeFile,
            `${SafeJSON.stringify({
                type: "event_msg",
                timestamp: "2026-08-27T20:00:00.000Z",
                payload: { type: "agent_message", message: "from native" },
            })}\n`
        );
        const native = await transcriptEnvelope({
            provider: "codex",
            source: "native",
            sessionId: "nat",
            filePath: nativeFile,
        });
        expect(native.turns[0]?.text).toBe("from native");
    });
});

const recordCacheRoot = mkdtempSync(join(tmpdir(), "gt-record-cache-"));
const line = (n: number) => `{"type":"event","n":${n},"text":"${"x".repeat(n % 7)}"}`;
const read = (path: string) => readRecordsAppendOnly(path, { minCacheBytes: 0 });

describe("readRecordsAppendOnly", () => {
    test("appends, an unfinished last line and its completion read like a fresh file", () => {
        const path = join(recordCacheRoot, "growing.jsonl");
        writeFileSync(path, `${line(1)}\n${line(2)}\n`);
        expect(read(path).map((record) => record.n)).toEqual([1, 2]);

        appendFileSync(path, `${line(3)}\n{"type":"event","n":4`);
        // The half-written record is not a record yet, and is not kept.
        expect(read(path).map((record) => record.n)).toEqual([1, 2, 3]);

        appendFileSync(path, `,"text":""}\n${line(5)}`);
        // A last line with no newline yet still counts, as a full read counts it.
        expect(read(path).map((record) => record.n)).toEqual([1, 2, 3, 4, 5]);
        appendFileSync(path, `\n${line(6)}\n`);
        expect(read(path).map((record) => record.n)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    test("a rewrite in place, a replaced file and a missing file start over", () => {
        const path = join(recordCacheRoot, "rewritten.jsonl");
        writeFileSync(path, `${line(1)}\n${line(2)}\n`);
        expect(read(path).map((record) => record.n)).toEqual([1, 2]);
        writeFileSync(path, `${line(7)}\n${line(8)}\n${line(9)}\n`);
        expect(read(path).map((record) => record.n)).toEqual([7, 8, 9]);

        const other = join(recordCacheRoot, "other.jsonl");
        writeFileSync(other, `${line(10)}\n`);
        renameSync(other, path);
        expect(read(path).map((record) => record.n)).toEqual([10]);
        // An unreadable file is an error, as the whole-file read was; `readRecords` returns [] for a missing one.
        expect(() => read(join(recordCacheRoot, "missing.jsonl"))).toThrow(/ENOENT/);
    });
});

describe("foldTurnsAppendOnly", () => {
    const row = (role: "user" | "assistant", text: string) =>
        `${SafeJSON.stringify({
            type: "response_item",
            timestamp: "2026-10-08T05:00:00.000Z",
            payload: {
                type: "message",
                role,
                content: [{ type: role === "user" ? "input_text" : "output_text", text }],
            },
        })}\n`;
    const call = (id: string) =>
        `${SafeJSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: id, name: "exec_command", arguments: '{"cmd":"ls"}' } })}\n`;
    const output = (id: string) =>
        `${SafeJSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: "done" } })}\n`;
    const fold = (file: string) => foldTurnsAppendOnly(file, createCodexTurnParser, { minBytes: 0 });
    const full = (file: string) => codexNativeLinesToTurns(fs.readFileSync(file, "utf8").split("\n"));

    test("matches a full parse after appends, a result arriving for an earlier call, and a rewrite in place", () => {
        const file = join(fixtureRoot(), "rollout.jsonl");
        writeFileSync(file, row("user", "first") + row("assistant", "one") + call("c1"));
        expect(fold(file)).toEqual(full(file));

        appendFileSync(file, row("assistant", "two") + output("c1") + row("user", "second"));
        expect(fold(file)).toEqual(full(file));
        expect(
            fold(file)
                ?.flatMap((turn) => turn.tools)
                .map((tool) => tool.result)
        ).toEqual(["done"]);

        // Same inode, longer than before, other first bytes: only the byte mark tells, and it is read again.
        const longer = Array.from({ length: 8 }, (_, i) => row("assistant", `rewritten ${i}`)).join("");
        writeFileSync(file, row("user", "rewritten and longer than before") + longer);
        expect(fs.statSync(file).size).toBeGreaterThan(900);
        expect(fold(file)).toEqual(full(file));
        expect(fold(file)?.[0]?.text).toBe("rewritten and longer than before");
    });

    test("leaves a complete last line without its newline, and an app-server event file, to the full parse", () => {
        const file = join(fixtureRoot(), "rollout.jsonl");
        writeFileSync(file, row("user", "first") + row("assistant", "done").trimEnd());
        expect(fold(file)).toBeNull();
        appendFileSync(file, "\n");
        expect(fold(file)).toEqual(full(file));

        const events = join(fixtureRoot(), "events.jsonl");
        writeFileSync(events, `${SafeJSON.stringify({ method: "item/completed", params: {} })}\n`);
        expect(fold(events)).toBeNull();
    });

    test("files below the size threshold are left to the full parse", () => {
        const file = join(fixtureRoot(), "small.jsonl");
        writeFileSync(file, row("user", "hi"));
        expect(foldTurnsAppendOnly(file, createCodexTurnParser)).toBeNull();
    });
});
