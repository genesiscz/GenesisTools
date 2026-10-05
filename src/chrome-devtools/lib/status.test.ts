import { describe, expect, it } from "bun:test";
import { isDeadPort, type PortStatus } from "./status.ts";

function port(over: Partial<PortStatus>): PortStatus {
    return {
        port: 55555,
        pidState: { status: "none" },
        meta: null,
        sample: null,
        segments: { count: 0, bytes: 0, oldestMs: null, newestMs: null },
        endpoint: null,
        ...over,
    } as PortStatus;
}

describe("isDeadPort", () => {
    it("flags a leftover dir with no recorder, buffer or CDP", () => {
        expect(isDeadPort(port({}))).toBe(true);
    });

    it("keeps a port that still has buffered segments", () => {
        expect(isDeadPort(port({ segments: { count: 2, bytes: 10, oldestMs: 1, newestMs: 2 } }))).toBe(false);
    });

    it("keeps a port where a browser answers CDP", () => {
        expect(isDeadPort(port({ endpoint: { browser: "Chrome/1", pages: 1 } }))).toBe(false);
    });

    it("keeps a port with a stale pidfile so doctor can explain it", () => {
        expect(isDeadPort(port({ pidState: { status: "dead" } as PortStatus["pidState"] }))).toBe(false);
    });
});
