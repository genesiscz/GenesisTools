import { describe, expect, it } from "bun:test";
import type { DashboardSession } from "./log-source";
import { sessionRecencyTs, sortSessionsByRecency } from "./session-recency";

function session(name: string, lastActivityAt: number, exitedAt?: number): DashboardSession {
    return {
        source: "task",
        name,
        badge: "task",
        projectPath: "",
        createdAt: 0,
        lastActivityAt,
        exitedAt,
        state: exitedAt ? "exited" : "active",
        stateLabel: "active",
    };
}

describe("sessionRecencyTs", () => {
    it("uses the later of lastActivityAt and exitedAt", () => {
        expect(sessionRecencyTs(session("a", 1000, 5000))).toBe(5000);
        expect(sessionRecencyTs(session("b", 9000, 3000))).toBe(9000);
    });
});

describe("sortSessionsByRecency", () => {
    it("orders most recently active first", () => {
        const sorted = sortSessionsByRecency([
            session("old", 1000),
            session("newer", 9000),
            session("killed", 2000, 8000),
        ]);

        expect(sorted.map((entry) => entry.name)).toEqual(["newer", "killed", "old"]);
    });
});
