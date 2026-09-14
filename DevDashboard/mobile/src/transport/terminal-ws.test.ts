import { describe, expect, it, mock } from "bun:test";

// `terminal-ws.ts` statically imports `partysocket` (a WebSocket impl) and `react-native`
// (`AppState`), both unloadable under bun. Stub them so the pure `heartbeatReducer` (the
// unit under test) is reachable; the socket wiring is exercised by the plan-06 Appium spec.
mock.module("partysocket", () => ({ WebSocket: class {} }));
mock.module("react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));

const { heartbeatReducer } = await import("@/transport/terminal-ws");
type HeartbeatState = import("@/transport/terminal-ws").HeartbeatState;

describe("heartbeatReducer", () => {
    const initial: HeartbeatState = { pendingPings: 0, dead: false };

    it("counts an outgoing ping", () => {
        const s = heartbeatReducer(initial, { type: "ping-sent" });
        expect(s.pendingPings).toBe(1);
    });

    it("clears pending pings on pong", () => {
        const s = heartbeatReducer({ pendingPings: 2, dead: false }, { type: "pong" });
        expect(s.pendingPings).toBe(0);
    });

    it("marks dead after 2 missed pongs", () => {
        let s = heartbeatReducer(initial, { type: "ping-sent" });
        s = heartbeatReducer(s, { type: "ping-sent" });
        expect(s.dead).toBe(true);
    });
});
