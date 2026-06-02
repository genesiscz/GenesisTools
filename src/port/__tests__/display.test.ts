import { describe, expect, it } from "bun:test";
import { toPortJson, toProcessJson } from "../lib/display";
import type { PortSnapshot, ProcessSnapshot } from "../lib/types";

function makePortSnapshot(overrides: Partial<PortSnapshot> = {}): PortSnapshot {
    return {
        port: 3000,
        pid: 123,
        processName: "node",
        command: "node server.js",
        user: "alice",
        state: "LISTEN",
        name: "*:3000",
        fd: "21u",
        cwd: "/tmp/project",
        projectName: "project",
        framework: "Next.js",
        uptime: "2h",
        startTime: new Date("2026-06-02T08:30:00.000Z"),
        memory: "120MB",
        status: "healthy",
        ...overrides,
    };
}

function makeProcessSnapshot(overrides: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
    return {
        pid: 456,
        ppid: 1,
        processName: "bun",
        command: "bun run dev",
        user: "bob",
        cpu: 12.5,
        memory: "80MB",
        cwd: "/tmp/app",
        projectName: "app",
        framework: "Vite",
        uptime: "10m",
        startTime: new Date("2026-06-02T09:00:00.000Z"),
        description: "dev server",
        status: "healthy",
        listeningPorts: [5173],
        ...overrides,
    };
}

describe("toPortJson", () => {
    it("serializes Date startTime to a deterministic ISO string", () => {
        const result = toPortJson([makePortSnapshot()]);

        expect(result).toHaveLength(1);
        expect(result[0].startTime).toBe("2026-06-02T08:30:00.000Z");
        expect(result[0]).toMatchObject({
            port: 3000,
            pid: 123,
            processName: "node",
            user: "alice",
            state: "LISTEN",
            framework: "Next.js",
            status: "healthy",
        });
    });

    it("keeps a null startTime as null", () => {
        const result = toPortJson([makePortSnapshot({ startTime: null, framework: null, cwd: null })]);

        expect(result[0].startTime).toBeNull();
        expect(result[0].framework).toBeNull();
        expect(result[0].cwd).toBeNull();
    });

    it("preserves order and serializes every entry", () => {
        const result = toPortJson([makePortSnapshot({ pid: 1, port: 3000 }), makePortSnapshot({ pid: 2, port: 3001 })]);

        expect(result.map((entry) => entry.pid)).toEqual([1, 2]);
        expect(result.map((entry) => entry.port)).toEqual([3000, 3001]);
    });

    it("returns an empty array for no snapshots", () => {
        expect(toPortJson([])).toEqual([]);
    });
});

describe("toProcessJson", () => {
    it("serializes Date startTime to a deterministic ISO string and keeps listeningPorts", () => {
        const result = toProcessJson([makeProcessSnapshot()]);

        expect(result).toHaveLength(1);
        expect(result[0].startTime).toBe("2026-06-02T09:00:00.000Z");
        expect(result[0].listeningPorts).toEqual([5173]);
        expect(result[0]).toMatchObject({
            pid: 456,
            ppid: 1,
            processName: "bun",
            cpu: 12.5,
            framework: "Vite",
        });
    });

    it("keeps a null startTime as null", () => {
        const result = toProcessJson([makeProcessSnapshot({ startTime: null })]);

        expect(result[0].startTime).toBeNull();
    });
});
