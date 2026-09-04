import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { planFollowRead, takeCompleteLines } from "./tail";

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

    test("an emptied file rewinds too", () => {
        expect(planFollowRead(0, 120)).toEqual({ from: 0, rewound: true });
    });
});
