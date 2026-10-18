import { describe, expect, it } from "bun:test";
import { captureOut } from "@genesiscz/utils/test/capture-out";
import {
    displayCleanPreview,
    displayCleanResults,
    displayPortDetail,
    displayPortTable,
    displayProcessTable,
    displayWatchEvent,
    displayWatchHeader,
    toPortJson,
    toProcessJson,
} from "../lib/display";
import type { KillResult, PortSnapshot, ProcessSnapshot } from "../lib/types";

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

describe("displayPortTable", () => {
    it("explains an empty result and points at --all", () => {
        const text = captureOut(() => displayPortTable([], true));

        expect(text).toContain("Port Overview");
        expect(text).toContain("No matching listening ports found.");
        expect(text).toContain("tools port --all");
        expect(text).not.toContain("PORT");
    });

    it("prints one row per listener with its process, project, framework and uptime", () => {
        const text = captureOut(() => displayPortTable([makePortSnapshot()], false));

        expect(text).toMatch(/:3000\s+│\s+node\s+│\s+123\s+│\s+project\s+│\s+Next\.js\s+│\s+2h\s+│\s+● healthy/);
        expect(text).toContain("1 port active");
        expect(text).toContain("tools port <number>");
    });

    it("counts listeners in the plural and only offers --all when the list was filtered", () => {
        const two = [makePortSnapshot({ port: 3000 }), makePortSnapshot({ port: 3001, pid: 124 })];

        const filtered = captureOut(() => displayPortTable(two, true));
        const everything = captureOut(() => displayPortTable(two, false));

        expect(filtered).toContain("2 ports active");
        expect(filtered).toContain("--all to show everything");
        expect(everything).toContain("2 ports active");
        expect(everything).not.toContain("to show everything");
    });

    it("shows a dash for a missing project, framework and uptime, and cuts a long project name at 20 characters", () => {
        const bare = captureOut(() =>
            displayPortTable([makePortSnapshot({ projectName: null, framework: null, uptime: null })], false)
        );
        const long = captureOut(() =>
            displayPortTable([makePortSnapshot({ projectName: "a-project-name-longer-than-twenty" })], false)
        );

        expect(bare).toMatch(/node\s+│\s+123\s+│\s+—\s+│\s+—\s+│\s+—\s+│/);
        expect(long).toContain("a-project-name-long…");
        expect(long).not.toContain("a-project-name-longer");
    });

    it("labels each process status with its own word", () => {
        const text = captureOut(() =>
            displayPortTable(
                [
                    makePortSnapshot({ port: 1, status: "healthy" }),
                    makePortSnapshot({ port: 2, status: "orphaned" }),
                    makePortSnapshot({ port: 3, status: "zombie" }),
                    makePortSnapshot({ port: 4, status: "unknown" }),
                ],
                false
            )
        );

        expect(text).toMatch(/:1\b.*● healthy/);
        expect(text).toMatch(/:2\b.*● orphaned/);
        expect(text).toMatch(/:3\b.*● zombie/);
        expect(text).toMatch(/:4\b.*● unknown/);
    });

    it("keeps the framework name for frameworks it has no colour for", () => {
        const text = captureOut(() => displayPortTable([makePortSnapshot({ framework: "Phoenix" })], false));

        expect(text).toContain("Phoenix");
    });
});

describe("displayPortDetail", () => {
    it("says so when nothing listens on the port", () => {
        const text = captureOut(() => displayPortDetail(8080, [], null));

        expect(text).toContain("Port :8080");
        expect(text).toContain("No process found on that port.");
        expect(text).not.toContain("Location");
    });

    it("shows the process table and the location of the first listener", () => {
        const snapshot = makePortSnapshot({ port: 5173, cwd: "/tmp/web", command: "bun run dev", memory: "64MB" });
        const text = captureOut(() => displayPortDetail(5173, [snapshot], "feat/ports"));

        expect(text).toMatch(/123\s+│\s+node\s+│\s+alice\s+│\s+LISTEN/);
        expect(text).toMatch(/Directory\s+\/tmp\/web/);
        expect(text).toMatch(/Command\s+bun run dev/);
        expect(text).toMatch(/Started\s+/);
        expect(text).toContain(new Date("2026-06-02T08:30:00.000Z").toLocaleString());
        expect(text).toMatch(/Memory\s+64MB/);
        expect(text).toMatch(/Git Branch\s+feat\/ports/);
        expect(text).toContain("tools port --kill <number>");
    });

    it("shows a dash for every location field the process does not report", () => {
        const snapshot = makePortSnapshot({ cwd: null, startTime: null, memory: null });
        const text = captureOut(() => displayPortDetail(3000, [snapshot], null));

        expect(text).toMatch(/Directory\s+—/);
        expect(text).toMatch(/Started\s+—/);
        expect(text).toMatch(/Memory\s+—/);
        expect(text).toMatch(/Git Branch\s+—/);
    });

    it("cuts a command longer than 80 characters", () => {
        const command = `node ${"x".repeat(100)}`;
        const text = captureOut(() => displayPortDetail(3000, [makePortSnapshot({ command })], null));

        expect(text).toContain(`${command.slice(0, 79)}…`);
        expect(text).not.toContain(command);
    });

    it("lists every listener on the port, including one that is not in the LISTEN state", () => {
        const text = captureOut(() =>
            displayPortDetail(
                3000,
                [makePortSnapshot({ pid: 1 }), makePortSnapshot({ pid: 2, state: "ESTABLISHED", user: "bob" })],
                null
            )
        );

        expect(text).toMatch(/\b1\s+│\s+node\s+│\s+alice\s+│\s+LISTEN/);
        expect(text).toMatch(/\b2\s+│\s+node\s+│\s+bob\s+│\s+ESTABLISHED/);
    });
});

describe("displayProcessTable", () => {
    it("explains an empty result and points at port ps --all", () => {
        const text = captureOut(() => displayProcessTable([], true));

        expect(text).toContain("Process Overview");
        expect(text).toContain("No matching processes found.");
        expect(text).toContain("tools port ps --all");
    });

    it("shows the listening ports next to the description", () => {
        const text = captureOut(() => displayProcessTable([makeProcessSnapshot()], false));

        expect(text).toMatch(
            /456\s+│\s+bun\s+│\s+12\.5\s+│\s+80MB\s+│\s+app\s+│\s+Vite\s+│\s+10m\s+│\s+dev server \[:5173\]/
        );
        expect(text).toContain("1 process");
        expect(text).not.toContain("1 processes");
    });

    it("joins several listening ports and leaves a process without ports undecorated", () => {
        const text = captureOut(() =>
            displayProcessTable(
                [
                    makeProcessSnapshot({ pid: 10, listeningPorts: [3000, 3001] }),
                    makeProcessSnapshot({ pid: 11, listeningPorts: [], description: "worker" }),
                ],
                false
            )
        );

        expect(text).toContain("[:3000, :3001]");
        expect(text).toMatch(/worker\s+│/);
        expect(text).not.toMatch(/worker \[/);
        expect(text).toContain("2 processes");
    });

    it("prints CPU with one decimal for idle, busy and hot processes", () => {
        const text = captureOut(() =>
            displayProcessTable(
                [
                    makeProcessSnapshot({ pid: 1, cpu: 0 }),
                    makeProcessSnapshot({ pid: 2, cpu: 7.5 }),
                    makeProcessSnapshot({ pid: 3, cpu: 99.94 }),
                ],
                false
            )
        );

        expect(text).toMatch(/\b1\s+│\s+bun\s+│\s+0\.0\s+│/);
        expect(text).toMatch(/\b2\s+│\s+bun\s+│\s+7\.5\s+│/);
        expect(text).toMatch(/\b3\s+│\s+bun\s+│\s+99\.9\s+│/);
    });

    it("shows a dash for missing memory, project, framework and uptime, and offers --all only when filtered", () => {
        const bare = makeProcessSnapshot({ memory: null, projectName: null, framework: null, uptime: null });
        const filtered = captureOut(() => displayProcessTable([bare], true));
        const everything = captureOut(() => displayProcessTable([bare], false));

        expect(filtered).toMatch(/12\.5\s+│\s+—\s+│\s+—\s+│\s+—\s+│\s+—\s+│/);
        expect(filtered).toContain("--all to show everything");
        expect(everything).not.toContain("to show everything");
    });

    it("cuts a long process name at 15 characters and a long description at 34", () => {
        const text = captureOut(() =>
            displayProcessTable(
                [makeProcessSnapshot({ processName: "a-very-long-process-name", description: "d".repeat(60) })],
                false
            )
        );

        expect(text).toContain("a-very-long-pr…");
        expect(text).toContain(`${"d".repeat(33)}…`);
    });
});

describe("displayCleanPreview and displayCleanResults", () => {
    it("report that there is nothing to clean in both views", () => {
        expect(captureOut(() => displayCleanPreview([]))).toContain("No orphaned or zombie listeners found.");
        expect(captureOut(() => displayCleanResults([], []))).toContain("No orphaned or zombie listeners found.");
    });

    it("previews each orphaned listener with its status", () => {
        const text = captureOut(() =>
            displayCleanPreview([
                makePortSnapshot({ port: 4000, pid: 9, status: "orphaned" }),
                makePortSnapshot({ port: 4001, pid: 10, status: "zombie", projectName: null }),
            ])
        );

        expect(text).toContain("Port Cleanup");
        expect(text).toMatch(/:4000\s+│\s+9\s+│\s+node\s+│\s+project\s+│\s+● orphaned/);
        expect(text).toMatch(/:4001\s+│\s+10\s+│\s+node\s+│\s+—\s+│\s+● zombie/);
    });

    it("marks a killed listener, a forced one and a failed one differently", () => {
        const orphaned = [
            makePortSnapshot({ port: 4000, pid: 1 }),
            makePortSnapshot({ port: 4001, pid: 2 }),
            makePortSnapshot({ port: 4002, pid: 3 }),
        ];
        const results: KillResult[] = [
            { pid: 1, status: "killed" },
            { pid: 2, status: "force-killed" },
            { pid: 3, status: "failed", error: "EPERM: operation not permitted" },
        ];
        const text = captureOut(() => displayCleanResults(orphaned, results));

        expect(text).toContain("cleanup results");
        expect(text).toContain("✓ :4000 — node (PID 1)");
        expect(text).toContain("! :4001 — node (PID 2) forced");
        expect(text).toContain("✕ :4002 — node (PID 3)");
        expect(text).toContain("EPERM: operation not permitted");
    });

    it("falls back to a generic message for a failure without an error, and counts a listener with no result as killed", () => {
        const orphaned = [makePortSnapshot({ port: 4000, pid: 1 }), makePortSnapshot({ port: 4001, pid: 2 })];
        const text = captureOut(() => displayCleanResults(orphaned, [{ pid: 1, status: "failed" }]));

        expect(text).toContain("✕ :4000 — node (PID 1)");
        expect(text).toContain("Failed to kill process");
        expect(text).toContain("✓ :4001 — node (PID 2)");
    });
});

describe("displayWatchHeader and displayWatchEvent", () => {
    it("names the watch scope and the poll interval", () => {
        const dev = captureOut(() => displayWatchHeader(false, 1500));
        const all = captureOut(() => displayWatchHeader(true, 250));

        expect(dev).toContain("Port Watch");
        expect(dev).toContain("Scope: dev-focused listeners · poll 1500ms");
        expect(dev).toContain("Press Ctrl+C to stop.");
        expect(all).toContain("Scope: all listeners · poll 250ms");
    });

    it("prints an opened port with its process, project and framework", () => {
        const text = captureOut(() => displayWatchEvent("new", makePortSnapshot()));

        expect(text).toContain("▲ OPEN   :3000 ← node [project] Next.js");
    });

    it("leaves out the project and framework a new listener does not have", () => {
        const text = captureOut(() =>
            displayWatchEvent("new", makePortSnapshot({ projectName: null, framework: null }))
        );

        expect(text).toContain("▲ OPEN   :3000 ← node");
        expect(text).not.toContain("[");
    });

    it("prints a closed port without a process name", () => {
        const text = captureOut(() => displayWatchEvent("removed", makePortSnapshot()));

        expect(text).toContain("▼ CLOSED :3000");
        expect(text).not.toContain("node");
    });
});
