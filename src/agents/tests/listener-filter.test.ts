import { describe, expect, test } from "bun:test";
import { createListenerFilter } from "../lib/listener-filter";
import type { FeedEvent, MessageEvent } from "../lib/types";

function message(body: string): MessageEvent {
    return {
        type: "message",
        seq: 1,
        ts: "now",
        message_id: "0001",
        from_agent_id: "agt_0001",
        from_agent_name: "worker",
        to_agent_ids: ["main_test"],
        body,
        meta: {},
        private: false,
    };
}

describe("agents listener filter", () => {
    test("matches feed types and structured body kinds", () => {
        const filter = createListenerFilter({ kinds: "message,approval_request" });
        const lifecycle: FeedEvent = {
            type: "logged_in",
            seq: 2,
            ts: "now",
            agent_id: "agt_0001",
            agent_name: "worker",
            mode: "stream",
        };

        expect(filter(message("plain text"))).toBe(true);
        expect(filter(message('{"op":"approval_request"}'))).toBe(true);
        expect(filter(message('{"event":"turn_completed"}'))).toBe(true);
        expect(filter(lifecycle)).toBe(false);
    });

    test("supports the documented jq-ish equality expression", () => {
        const filter = createListenerFilter({ expression: '.op=="approval_request"' });

        expect(filter(message('{"op":"approval_request","requestId":"r1"}'))).toBe(true);
        expect(filter(message('{"op":"steer"}'))).toBe(false);
        expect(filter(message("plain text"))).toBe(false);
    });

    test("rejects unsupported expressions instead of evaluating code", () => {
        expect(() => createListenerFilter({ expression: "process.exit(1)" })).toThrow(
            "Unsupported --filter expression"
        );
    });
});
