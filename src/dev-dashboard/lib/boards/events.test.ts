import { afterEach, describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { publishBoardEvent, resetEventHub, subscribeBoard, waitForWorkSignal, wakeWorkWaiters } from "./events";

describe("events hub", () => {
    afterEach(() => {
        resetEventHub();
    });

    it("delivers a published event to a subscribed sink as a JSON frame", () => {
        const received: string[] = [];
        const unsubscribe = subscribeBoard("b1", (frame) => received.push(frame));
        publishBoardEvent("b1", { type: "card", payload: { id: 1 } });
        expect(received.length).toBe(1);
        expect(SafeJSON.parse(received[0], { strict: true })).toEqual({ type: "card", payload: { id: 1 } });
        unsubscribe();
    });

    it("does not deliver to a different board's subscribers", () => {
        const received: string[] = [];
        subscribeBoard("b1", (frame) => received.push(frame));
        publishBoardEvent("b2", { type: "card", payload: {} });
        expect(received.length).toBe(0);
    });

    it("unsubscribe stops further delivery", () => {
        const received: string[] = [];
        const unsubscribe = subscribeBoard("b1", (frame) => received.push(frame));
        unsubscribe();
        publishBoardEvent("b1", { type: "card", payload: {} });
        expect(received.length).toBe(0);
    });

    it("a throwing sink does not break delivery to other sinks", () => {
        const received: string[] = [];
        subscribeBoard("b1", () => {
            throw new Error("boom");
        });
        subscribeBoard("b1", (frame) => received.push(frame));
        expect(() => publishBoardEvent("b1", { type: "card", payload: {} })).not.toThrow();
        expect(received.length).toBe(1);
    });

    it("waitForWorkSignal resolves timeout when nothing wakes it", async () => {
        const result = await waitForWorkSignal(30);
        expect(result).toBe("timeout");
    });

    it("waitForWorkSignal resolves wake when wakeWorkWaiters fires", async () => {
        const pending = waitForWorkSignal(2000);
        setTimeout(() => wakeWorkWaiters(), 5);
        const result = await pending;
        expect(result).toBe("wake");
    });
});
