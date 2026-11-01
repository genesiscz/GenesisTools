import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { parseJsonlTranscript } from "./index";

interface Line {
    uuid?: string;
    n: number;
}

function writeTranscript(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "transcript-test-"));
    const path = join(dir, "session.jsonl");
    writeFileSync(path, lines.join("\n"));
    return path;
}

describe("parseJsonlTranscript uuid dedupe", () => {
    const lines = [
        '{"uuid": "a", "n": 1}',
        '{"uuid": "b", "n": 2}',
        '{"uuid": "a", "n": 3}',
        '{"n": 4}',
        '{"n": 5}',
        "not json at all",
        '{"uuid": "b", "n": 6}',
    ];

    test("default keeps duplicated uuid lines (compat)", async () => {
        const messages = await parseJsonlTranscript<Line>(writeTranscript(lines));
        expect(messages.map((m) => m.n)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    test("dedupeUuids drops repeats, first occurrence wins; uuid-less lines untouched", async () => {
        const messages = await parseJsonlTranscript<Line>(writeTranscript(lines), { dedupeUuids: true });
        expect(messages.map((m) => m.n)).toEqual([1, 2, 4, 5]);
    });

    test("missing file returns empty array", async () => {
        const messages = await parseJsonlTranscript("/nonexistent/never.jsonl", { dedupeUuids: true });
        expect(messages).toEqual([]);
    });
});

describe("parseJsonlTranscript line splitting", () => {
    test("a record with raw U+2028 and U+2029 in a string stays one message (node:readline cut it in three)", async () => {
        const text = "before between after";
        const record = SafeJSON.stringify({ uuid: "a", n: 1, text }, { strict: true });
        expect(record).toContain(" ");
        const messages = await parseJsonlTranscript<Line & { text?: string }>(writeTranscript([record, '{"n": 2}']));

        expect(messages.map((m) => m.n)).toEqual([1, 2]);
        expect(messages[0]?.text).toBe(text);
    });
});
