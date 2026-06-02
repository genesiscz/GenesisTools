import { describe, expect, it, mock } from "bun:test";

// `sse-parser.ts` statically imports `expo/fetch`, which transitively loads the
// `react-native` Flow entry bun can't parse. Stub it so the pure `SseFramer` (the unit
// under test) is reachable without a native runtime; the effectful `streamSse` wrapper is
// validated by tsc + on-device, not here.
mock.module("expo/fetch", () => ({ fetch: async () => new Response("") }));

const { SseFramer } = await import("@/transport/sse-parser");

describe("SseFramer", () => {
    it("emits one event per data: line after a blank line", () => {
        const out: string[] = [];
        const f = new SseFramer((ev) => out.push(ev.data));
        f.push("data: hello\n\n");
        expect(out).toEqual(["hello"]);
    });

    it("buffers across chunk boundaries (event split mid-stream)", () => {
        const out: string[] = [];
        const f = new SseFramer((ev) => out.push(ev.data));
        f.push("data: par");
        f.push("tial\n");
        f.push("\n");
        expect(out).toEqual(["partial"]);
    });

    it("ignores comment keep-alives (: ping)", () => {
        const out: string[] = [];
        const f = new SseFramer((ev) => out.push(ev.data));
        f.push(": ping\n\n");
        f.push("data: real\n\n");
        expect(out).toEqual(["real"]);
    });

    it("joins multi-line data: fields with newline", () => {
        const out: string[] = [];
        const f = new SseFramer((ev) => out.push(ev.data));
        f.push("data: a\ndata: b\n\n");
        expect(out).toEqual(["a\nb"]);
    });

    it("captures event: and id: fields", () => {
        const events: { event?: string; id?: string; data: string }[] = [];
        const f = new SseFramer((ev) => events.push(ev));
        f.push("event: qa\nid: 7\ndata: x\n\n");
        expect(events[0]).toEqual({ event: "qa", id: "7", data: "x" });
    });
});
