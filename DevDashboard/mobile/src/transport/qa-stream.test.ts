import { describe, expect, it, mock } from "bun:test";

// `qa-stream.ts` → `sse-parser.ts` statically imports `expo/fetch` (native). Stub it so the
// pure stream logic (parse + dedupe) runs under bun; the test injects its own fake
// `streamSseImpl`, so the real fetch is never called regardless.
mock.module("expo/fetch", () => ({ fetch: async () => new Response("") }));

const { createQaStream } = await import("@/transport/qa-stream");
type SseEvent = import("@/transport/sse-parser").SseEvent;

function fakeStreamFactory(scripted: SseEvent[]) {
    return (opts: { onEvent: (e: SseEvent) => void; onOpen?: () => void }) => {
        opts.onOpen?.();
        for (const e of scripted) {
            opts.onEvent(e);
        }

        return { close() {} };
    };
}

describe("createQaStream", () => {
    it("parses each data: frame as a QaRow and forwards open->open status", () => {
        const rows: string[] = [];
        const statuses: string[] = [];
        const stream = createQaStream({
            baseUrl: "http://h",
            authHeader: () => "Basic z",
            streamSseImpl: fakeStreamFactory([{ data: JSON.stringify({ id: "1", question: "q", answer: "a" }) }]),
        });
        stream.connect(
            (entry) => rows.push(entry.id),
            (s) => statuses.push(s),
        );
        expect(rows).toEqual(["1"]);
        expect(statuses).toContain("open");
    });

    it("dedupes a re-delivered id", () => {
        const rows: string[] = [];
        const stream = createQaStream({
            baseUrl: "http://h",
            authHeader: () => undefined,
            streamSseImpl: fakeStreamFactory([
                { data: JSON.stringify({ id: "1", question: "q", answer: "a" }) },
                { data: JSON.stringify({ id: "1", question: "q", answer: "a" }) },
            ]),
        });
        stream.connect(
            (entry) => rows.push(entry.id),
            () => {},
        );
        expect(rows).toEqual(["1"]);
    });

    it("ignores a malformed frame without throwing", () => {
        const rows: string[] = [];
        const stream = createQaStream({
            baseUrl: "http://h",
            authHeader: () => undefined,
            streamSseImpl: fakeStreamFactory([{ data: "{not json" }]),
        });
        expect(() =>
            stream.connect(
                (e) => rows.push(e.id),
                () => {},
            ),
        ).not.toThrow();
        expect(rows).toEqual([]);
    });
});
