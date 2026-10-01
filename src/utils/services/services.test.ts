import { describe, expect, test } from "bun:test";
import type { PsRow } from "@genesiscz/utils/process/ps";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { classifyPid } from "@genesiscz/utils/process-identity";
import { getDashboard } from "@genesiscz/utils/ui/dashboards";
import { clientPortsFrom, connectedPorts, idleDecisions } from "./idle";
import {
    type LaunchdJob,
    listServices,
    parseLaunchctlList,
    parseLsofListeners,
    relaunchArgs,
    type ServiceProbe,
    type ServiceRow,
} from "./inventory";
import { stopService } from "./lifecycle";
import { sourceRoots, staleFiles } from "./stale";

const APP = "/Users/example/Applications/GenesisTools.app/Contents/MacOS/GenesisTools";
const REPO = "/Users/example/Projects/GenesisTools";

function ps(pid: number, ppid: number, command: string, start = "Sat Sep 12 16:39:32 2026"): PsRow {
    return { pid, ppid, user: "example", stat: "S", cpu: 0, rss: 1, startTime: new Date(start), command };
}

function probe(rows: PsRow[], listeners: Record<number, number[]>, jobs: LaunchdJob[] = []): ServiceProbe {
    return {
        processes: () => rows,
        listeners: () => new Map(Object.entries(listeners).map(([pid, ports]) => [Number(pid), ports])),
        launchdJobs: () => jobs,
        cwd: () => REPO,
    };
}

describe("parsers", () => {
    test("launchctl list keeps only GenesisTools jobs, with no pid when stopped", () => {
        const stdout = [
            "PID\tStatus\tLabel",
            "3611\t0\tcom.genesis-tools.log-dashboard",
            "-\t0\tcom.genesis-tools.youtube-server",
            "88\t0\tcom.apple.example",
        ].join("\n");

        expect(parseLaunchctlList(stdout)).toEqual([
            { label: "com.genesis-tools.log-dashboard", pid: 3611 },
            { label: "com.genesis-tools.youtube-server", pid: null },
        ]);
    });

    test("lsof listeners map a pid to every port, IPv4 and IPv6", () => {
        expect(parseLsofListeners(["p10", "n127.0.0.1:3074", "n[::1]:3074", "p20", "n*:8317"].join("\n"))).toEqual(
            new Map([
                [10, [3074]],
                [20, [8317]],
            ])
        );
    });

    test("established connections give their local ports, so a port that is only dialled has no client", () => {
        const stdout = [
            "p10",
            "n127.0.0.1:3074->127.0.0.1:55001",
            "p99",
            "n127.0.0.1:55001->127.0.0.1:3074",
            "n[::1]:3075->[::1]:55002",
            "n127.0.0.1:55003->127.0.0.1:3076",
        ].join("\n");

        const ports = connectedPorts(stdout);
        expect([3074, 3075, 3076].map((port) => ports.has(port))).toEqual([true, true, false]);
    });

    test("an lsof that failed is unknown, not idle; one with nothing to list is no clients", () => {
        expect(clientPortsFrom({ status: 1, stdout: "", stderr: "" })).toEqual(new Set());
        expect(clientPortsFrom({ status: 1, stdout: "", stderr: "lsof: cannot open /dev/kmem" })).toBeNull();
        expect(clientPortsFrom({ status: 1, stdout: "p10\nn127.0.0.1:3074->127.0.0.1:55001", stderr: "" })).toBeNull();
        expect(clientPortsFrom({ status: null, stdout: "", stderr: "" })).toBeNull();
    });
});

describe("listServices", () => {
    const youtube = getDashboard("youtube");
    const vite = `${APP} /Users/example/.bun/bin/bun --bun ${REPO}/node_modules/vite/bin/vite.js dev -c ${REPO}/src/youtube/ui/vite.config.ts`;

    test("a registered listener becomes one row: root, subtree, launchd label and start time", () => {
        const rows = listServices(
            probe(
                [ps(3614, 1, vite), ps(3721, 3614, vite), ps(3797, 3721, vite.replace(`${APP} `, ""))],
                { 3797: [youtube.port] },
                [{ label: "com.genesis-tools.youtube", pid: 3614 }]
            )
        );

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            id: "youtube",
            port: youtube.port,
            pid: 3797,
            rootPid: 3614,
            pids: [3614, 3721, 3797],
            managed: "launchd",
            label: "com.genesis-tools.youtube",
            startedAt: new Date("Sat Sep 12 16:39:32 2026").getTime(),
        });
    });

    test("a detached server's root is its topmost GenesisTools process, not the terminal above it", () => {
        const rows = listServices(
            probe([ps(500, 1, "/bin/zsh"), ps(501, 500, vite), ps(502, 501, vite.replace(`${APP} `, ""))], {
                502: [youtube.port],
            })
        );

        expect(rows[0]).toMatchObject({
            managed: "detached",
            rootPid: 501,
            pids: [501, 502],
            commands: { 501: vite, 502: vite.replace(`${APP} `, "") },
            cwd: REPO,
            label: null,
        });
    });

    test("a server started inside an agent session is never listed, so a restart cannot reach it", () => {
        const session = `${APP} /Users/example/.genesis-tools/bin/gt-task ${REPO}/src/task/index.ts run --session s1`;
        const rows = listServices(
            probe([ps(700, 1, session), ps(701, 700, vite)], { 701: [youtube.port] }, [
                { label: "com.genesis-tools.daemon", pid: 900 },
            ])
        );

        expect(rows).toEqual([]);
    });

    test("a foreign process on a registered port is not the service", () => {
        const rows = listServices(probe([ps(800, 1, "/usr/bin/python3 -m http.server")], { 800: [youtube.port] }));

        expect(rows).toEqual([]);
    });

    test("a launchd job with no registered port is listed by its label", () => {
        const daemon = `${APP} /Users/example/.bun/bin/bun run ${REPO}/src/daemon/daemon.ts`;
        const rows = listServices(probe([ps(7378, 1, daemon)], {}, [{ label: "com.genesis-tools.daemon", pid: 7378 }]));

        expect(rows[0]).toMatchObject({ id: "daemon", port: null, managed: "launchd", launch: null });
    });
});

describe("staleness", () => {
    test("source roots come from the paths in the command, plus src/utils", () => {
        expect(sourceRoots(`bun ${REPO}/src/youtube/ui/vite.config.ts --x ${REPO}/src/youtube/lib/a.ts`)).toEqual([
            "src/youtube/",
            "src/utils/",
        ]);
    });

    test("commits since the start and newer uncommitted edits make it stale; older edits do not", () => {
        const started = 1_000_000;
        const files = staleFiles({
            startedAt: started,
            command: `${REPO}/src/youtube/ui/x.ts`,
            deps: {
                committedSince: (since, roots) => {
                    expect({ since, roots }).toEqual({ since: started, roots: ["src/youtube/", "src/utils/"] });
                    return ["src/youtube/ui/a.ts"];
                },
                dirty: () => ["src/utils/new.ts", "src/utils/old.ts", "src/utils/gone.ts"],
                // gone.ts is an uncommitted deletion: no mtime, and the running process may still have it loaded.
                mtimeMs: (path) =>
                    path.endsWith("gone.ts") ? null : path.endsWith("new.ts") ? started + 1 : started - 1,
            },
        });

        expect(files).toEqual(["src/utils/gone.ts", "src/utils/new.ts", "src/youtube/ui/a.ts"]);
    });
});

describe("idleDecisions", () => {
    const row = (id: string, managed: ServiceRow["managed"], port: number | null = 3074): ServiceRow => ({
        id,
        name: id,
        port,
        pid: 1,
        rootPid: 1,
        pids: [1],
        commands: { 1: "" },
        cwd: null,
        startedAt: 100,
        managed,
        label: managed === "launchd" ? `com.genesis-tools.${id}` : null,
        launch: "tools example",
        command: "",
        relaunch: null,
    });
    const HOUR = 3_600_000;

    test("only a detached service with a port, idle for the whole window, is stopped", () => {
        const rows = [
            row("idle", "detached"),
            row("busy", "detached"),
            row("installed", "launchd"),
            row("noport", "detached", null),
        ];
        const { decisions, next } = idleDecisions({
            rows,
            active: (item) => item.id === "busy",
            state: { "idle@100": 0, "installed@100": 0 },
            now: 25 * HOUR,
            idleMs: 24 * HOUR,
        });

        expect(decisions.map((item) => [item.row.id, item.stop])).toEqual([
            ["idle", true],
            ["busy", false],
        ]);
        expect(next).toEqual({ "idle@100": 0, "busy@100": 25 * HOUR });
    });

    test("a service seen for the first time gets the full window", () => {
        const { decisions } = idleDecisions({
            rows: [row("fresh", "detached")],
            active: () => false,
            state: {},
            now: 99 * HOUR,
            idleMs: 24 * HOUR,
        });

        expect(decisions[0]).toMatchObject({ stop: false, lastActive: 99 * HOUR });
    });
});

describe("relaunchArgs", () => {
    test("a detached server comes back with its own arguments, not the registry default", () => {
        expect(
            relaunchArgs([
                `/Users/example/.genesis-tools/bin/gt-artifact ${REPO}/src/artifact/index.ts serve notes --template steel --port 3076`,
            ])
        ).toEqual(["artifact", "serve", "notes", "--template", "steel", "--port", "3076"]);
    });

    test("the tools wrapper's arguments win when the root is the wrapper", () => {
        expect(
            relaunchArgs([
                `/Users/example/.bun/bin/bun run ${REPO}/tools youtube ui`,
                `${APP} /Users/example/.genesis-tools/bin/gt-youtube --preload x.ts ${REPO}/src/youtube/index.ts ui`,
            ])
        ).toEqual(["youtube", "ui"]);
    });

    test("a command that names no tool gives nothing", () => {
        expect(
            relaunchArgs([`/Users/example/.bun/bin/bun --bun ${REPO}/node_modules/vite/bin/vite.js dev`])
        ).toBeNull();
    });
});

describe("stopService", () => {
    const detached = (pid: number, command: string): ServiceRow => ({
        id: "sleeper",
        name: "sleeper",
        port: null,
        pid,
        rootPid: pid,
        pids: [pid],
        commands: { [pid]: command },
        cwd: null,
        startedAt: null,
        managed: "detached",
        label: null,
        launch: null,
        command,
        relaunch: null,
    });

    test("a pid that still runs the inventory's command is stopped", async () => {
        const child = Bun.spawn(["sleep", "30"], { env: process.env });

        expect(await stopService(detached(child.pid, "sleep 30"))).toMatchObject({ ok: true });
        expect(await child.exited).not.toBe(0);
    });

    test("a pid that ignores SIGTERM is killed, and the stop is verified", async () => {
        // An ignored signal survives exec, so `sleep 30` itself ignores SIGTERM.
        const child = Bun.spawn(["sh", "-c", "trap '' TERM; exec sleep 30"], { env: process.env });

        try {
            // Ready once the trap is set and the exec happened: the pid then runs the inventory's command line.
            const deadline = Date.now() + 5000;
            while (classifyPid(child.pid, "sleep 30").status !== "live") {
                if (Date.now() > deadline) {
                    throw new Error("the SIGTERM-ignoring fixture never exec'd sleep within 5 s");
                }

                await Bun.sleep(100);
            }

            const result = await stopService(detached(child.pid, "sleep 30"), { graceMs: 200, killGraceMs: 2000 });

            expect(result).toMatchObject({ ok: true });
            expect(result.message).toContain("killed");
            expect(await child.exited).not.toBe(0);
        } finally {
            child.kill("SIGKILL");
        }
    });

    test("a port that still answers after SIGKILL fails the stop, so a restart never doubles the server", async () => {
        const child = Bun.spawn(["sleep", "30"], { env: process.env });
        const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });

        try {
            const row = { ...detached(child.pid, "sleep 30"), port: server.port };
            const result = await stopService(row, { graceMs: 200, killGraceMs: 300 });

            expect(result).toMatchObject({ ok: false });
            expect(result.message).toContain(`port ${server.port} still answers`);
        } finally {
            server.stop(true);
            child.kill();
        }
    });

    test("a pid whose command differs from the inventory's is a reused pid and is never signalled", async () => {
        const child = Bun.spawn(["sleep", "30"], { env: process.env });

        try {
            await stopService(detached(child.pid, "/usr/bin/some-other-server --port 3074"));
            expect(isProcessAlive(child.pid)).toBe(true);
        } finally {
            child.kill();
        }
    });
});
