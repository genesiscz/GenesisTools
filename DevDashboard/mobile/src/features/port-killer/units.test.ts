import { describe, expect, it } from "bun:test";
import { byPortAsc, portLabel, protoLabel } from "@/features/port-killer/units";

describe("port-killer units", () => {
    it("formats a port label and proto", () => {
        expect(portLabel(3000)).toBe(":3000");
        expect(protoLabel("tcp6")).toBe("IPv6");
        expect(protoLabel("tcp4")).toBe("IPv4");
    });

    it("sorts ports ascending", () => {
        const sorted = byPortAsc([
            { port: 8787, pid: 1, command: "n", address: "*", proto: "tcp4" },
            { port: 3000, pid: 2, command: "b", address: "*", proto: "tcp4" },
        ]);
        expect(sorted.map((p) => p.port)).toEqual([3000, 8787]);
    });
});
