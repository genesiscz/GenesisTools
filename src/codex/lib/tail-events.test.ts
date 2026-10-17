import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import * as adapter from "./adapter";
import { sessionEventsPath } from "./paths";
import { type CodexSessionMeta, CodexSessionStore } from "./store";
import {
    countStartedTurns,
    followSessionEvents,
    numberTurnLine,
    planFollowRead,
    takeCompleteLines,
} from "./tail-events";

describe("takeCompleteLines", () => {
    // The regression: a size snapshot cut a record in half, the half failed to
    // parse and was dropped, and the other half was dropped on the next read.
    test("an event appended in two chunks is handed on exactly once, whole", () => {
        const record = `${SafeJSON.stringify({ source: "daemon", method: "turn_completed", params: { sessionId: "s1" }, seq: 7 })}\n`;
        const first = record.slice(0, 20);
        const second = record.slice(20);

        const afterFirst = takeCompleteLines(first);
        expect(afterFirst.complete).toBe("");
        expect(afterFirst.rest).toBe(first);

        const afterSecond = takeCompleteLines(afterFirst.rest + second);
        expect(afterSecond.complete).toBe(record);
        expect(afterSecond.rest).toBe("");

        const parsed = afterSecond.complete
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => SafeJSON.parse(line, { strict: true }) as { seq?: number });
        expect(parsed).toEqual([expect.objectContaining({ seq: 7 })]);
    });

    test("whole lines go out at once and only the unterminated tail waits", () => {
        const { complete, rest } = takeCompleteLines('{"seq":1}\n{"seq":2}\n{"se');
        expect(complete).toBe('{"seq":1}\n{"seq":2}\n');
        expect(rest).toBe('{"se');
    });

    test("a chunk that ends exactly on a newline leaves nothing behind", () => {
        expect(takeCompleteLines('{"seq":1}\n')).toEqual({ complete: '{"seq":1}\n', rest: "" });
    });
});

describe("follow decoding", () => {
    // The regression: each byte slice was decoded on its own with `.text()`, so a
    // multi-byte codepoint split across two reads became U+FFFD in the output.
    test("a codepoint split across two reads survives a streaming decoder", () => {
        const record = `${SafeJSON.stringify({ source: "daemon", method: "error", params: { message: "přerušeno" } })}\n`;
        const bytes = new TextEncoder().encode(record);
        // Cut one byte into the two-byte "ř", so each half is invalid alone.
        const cut = bytes.indexOf(0xc5) + 1;

        const naive = new TextDecoder().decode(bytes.slice(0, cut)) + new TextDecoder().decode(bytes.slice(cut));
        expect(naive).toContain("�");

        const decoder = new TextDecoder("utf-8");
        const streamed =
            decoder.decode(bytes.slice(0, cut), { stream: true }) +
            decoder.decode(bytes.slice(cut), { stream: true }) +
            decoder.decode();

        expect(streamed).toBe(record);
        expect(streamed).not.toContain("�");
    });
});

describe("planFollowRead", () => {
    test("reads only what was appended", () => {
        expect(planFollowRead(500, 200)).toEqual({ from: 200, rewound: false });
    });

    test("nothing new when the size has not moved", () => {
        expect(planFollowRead(200, 200)).toBeUndefined();
    });

    test("rewinds when the file was truncated or rotated", () => {
        // The follower used to hold the old, larger offset forever: `size >
        // offset` was false on every later poll, so it printed nothing again
        // while still looking like it was following.
        expect(planFollowRead(40, 5_000)).toEqual({ from: 0, rewound: true });
    });

    test("the real follower restarts rendered turn numbers on rewind and preserves them on append", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-tail-rewind-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const started = `${SafeJSON.stringify({ source: "app-server", method: "turn/started", params: { threadId: "t" } })}\n`;
            const done = `${SafeJSON.stringify({ source: "app-server", method: "turn/completed", params: { threadId: "t", turn: {} } })}\n`;
            const path = sessionEventsPath("rewind");
            mkdirSync(dirname(path), { recursive: true });
            const meta: CodexSessionMeta = {
                name: "rewind",
                daemonPid: process.pid,
                cwd: "/repo",
                sandbox: "read-only",
                approvalPolicy: "never",
                writePolicy: "deny",
                status: "running",
                agentName: "fixture",
                rendezvousSession: "parent",
                agentsEnabled: false,
                startedAt: "2026-01-01T00:00:00Z",
                lastEventAt: "2026-01-01T00:00:00Z",
                codexVersion: "fixture",
                pendingApprovals: {},
            };
            for (const rewound of [true, false]) {
                writeFileSync(path, started.repeat(3));
                let reads = 0;
                const output: string[] = [];
                const metadata = spyOn(CodexSessionStore.prototype, "readMeta").mockImplementation(() => {
                    if (++reads === 1) {
                        writeFileSync(path, (rewound ? "" : started.repeat(3)) + started + done);
                        return meta;
                    }
                    return null;
                });
                const print = spyOn(out, "println").mockImplementation((line) => {
                    output.push(String(line));
                });
                const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
                try {
                    await followSessionEvents("rewind", true);
                    expect(output).toHaveLength(2);
                    expect(output[0]).toContain(`turn ${rewound ? 1 : 4} started`);
                    expect(output[1]).toContain(`turn ${rewound ? 1 : 4} completed`);
                } finally {
                    metadata.mockRestore();
                    print.mockRestore();
                    sleep.mockRestore();
                }
            }
        });
    });

    test("seeds historical turns through bounded reads without formatting skipped output", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-tail-history-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const path = sessionEventsPath("history");
            mkdirSync(dirname(path), { recursive: true });
            const started = SafeJSON.stringify({ method: "turn/started", source: "app-server" });
            const output = SafeJSON.stringify({
                source: "app-server",
                method: "item/completed",
                params: { item: { type: "commandExecution", aggregatedOutput: "x".repeat(128 * 1024) } },
            });
            const body = `${[started, ...Array.from({ length: 20 }, () => output), started].join("\n")}\n`;
            writeFileSync(path, body);
            const file = Bun.file(path);
            const originalSlice = file.slice.bind(file);
            const slices = spyOn(file, "slice").mockImplementation(
                (start?: number | string, end?: number | string, type?: string) => {
                    const begin = typeof start === "number" ? start : 0;
                    const until = typeof end === "number" ? end : file.size;
                    const contentType = typeof start === "string" ? start : typeof end === "string" ? end : type;
                    expect(until - begin).toBeLessThanOrEqual(64 * 1024);
                    return originalSlice(begin, until, contentType);
                }
            );
            const files = spyOn(Bun, "file").mockReturnValue(file);
            const reads = spyOn(fs, "createReadStream");
            const formatted = spyOn(adapter, "formatStoredEventLine");
            const metadata = spyOn(CodexSessionStore.prototype, "readMeta").mockReturnValue(null);
            try {
                await followSessionEvents("history", true);
                expect(reads).toHaveBeenCalledTimes(1);
                expect(reads.mock.calls[0]?.[1]).toMatchObject({
                    highWaterMark: 64 * 1024,
                    end: Buffer.byteLength(body) - 1,
                });
                expect(formatted).not.toHaveBeenCalled();
                expect(countStartedTurns(body)).toBe(2);
                expect(formatted).not.toHaveBeenCalled();
            } finally {
                metadata.mockRestore();
                formatted.mockRestore();
                reads.mockRestore();
                files.mockRestore();
                slices.mockRestore();
            }
        });
    });

    test("an emptied file rewinds too", () => {
        expect(planFollowRead(0, 120)).toEqual({ from: 0, rewound: true });
    });
});

describe("turn numbers", () => {
    test("numbers a Codex turn's start and end lines, continuing after the turns already in the log", () => {
        const turns = { n: 2 };

        expect(numberTurnLine("▶ turn ? started", turns)).toBe("▶ turn 3 started");
        expect(numberTurnLine("✔ turn ? completed ($0.0100)", turns)).toBe("✔ turn 3 completed ($0.0100)");
        expect(numberTurnLine("🔧 command ls", turns)).toBe("🔧 command ls");
        expect(numberTurnLine("▶ turn 7 started", turns)).toBe("▶ turn 7 started");
    });

    test("counts the turns a log already started", () => {
        const started = SafeJSON.stringify({ source: "app-server", method: "turn/started", params: { threadId: "t" } });
        const done = SafeJSON.stringify({
            source: "app-server",
            method: "turn/completed",
            params: { threadId: "t", turn: {} },
        });

        expect(countStartedTurns(`${started}\n${done}\n${started}\n`)).toBe(2);
    });
});
