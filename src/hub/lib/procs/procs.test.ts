import { describe, expect, test } from "bun:test";
import type { PsRow } from "@genesiscz/utils/process/ps";
import { argvSessionId, classifyCommand } from "./classify";
import { type ProcsSources, parseLaunchctlList, parseTopPower, readProcsReport } from "./sources";
import { refusal, type SignalOps, stopOrphans, stopTree } from "./stop";
import { type BuildInput, buildProcsReport, type SessionLike } from "./tree";

// Invented pids, paths and session ids; the process shapes are copied from a real `ps -axo` dump.
const NOW = Date.parse("2026-09-26T18:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const HOME = "/Users/alice";
const GT = "/Users/alice/Projects/GenesisTools";

function row(pid: number, ppid: number, command: string, extra: Partial<PsRow> & { age?: number } = {}): PsRow {
    const { age = HOUR, ...rest } = extra;
    return {
        pid,
        ppid,
        user: "alice",
        stat: "S",
        cpu: 0,
        rss: 10_000,
        startTime: new Date(NOW - age),
        command,
        ...rest,
    };
}

/** A machine: one live Claude session under `tools cc run`, and the leftovers someone hunts by hand. */
function table(): PsRow[] {
    return [
        row(1, 0, "/sbin/launchd", { user: "root", age: 10 * DAY }),
        row(100, 1, "/Applications/cmux.app/Contents/MacOS/cmux", { age: 5 * DAY }),
        row(110, 100, "/bin/zsh -l", { age: 2 * HOUR }),
        // tools cc run -> tools claude run -> zsh -ic -> claude, with its MCP servers and a tool shell
        row(
            200,
            110,
            `${HOME}/.genesis-tools/bin/gt-cc --preload ${GT}/src/utils/bun/preload.ts ${GT}/src/cc/index.ts run work --resume agents-window`,
            { age: 2 * HOUR }
        ),
        row(201, 200, `bun run ${GT}/src/claude/index.ts run work --resume agents-window`, { age: 2 * HOUR }),
        row(202, 201, `/bin/zsh -ic exec ccc '--resume' '${S1}'`, { age: 2 * HOUR }),
        row(210, 202, `${HOME}/.bun/bin/claude --dangerously-skip-permissions --resume ${S1}`, {
            cpu: 10.5,
            rss: 1_000_000,
            age: 2 * HOUR,
        }),
        row(211, 210, `node ${HOME}/.bun/bin/context7-mcp`, { rss: 80_000 }),
        row(212, 210, `node ${HOME}/.bun/bin/graft mcp`, { rss: 70_000 }),
        row(213, 210, `bun ${GT}/tools claude mcp`, { rss: 30_000 }),
        row(
            214,
            213,
            `${HOME}/.genesis-tools/bin/gt-claude --preload ${GT}/src/utils/bun/preload.ts ${GT}/src/claude/index.ts mcp`,
            { rss: 150_000 }
        ),
        row(
            215,
            210,
            `/bin/zsh -c source ${HOME}/.claude/shell-snapshots/snapshot-zsh-1.sh && export CODEX_COMPANION_SESSION_ID='${S1}'`,
            { rss: 3_000 }
        ),
        row(216, 215, `bun ${GT}/tools hub procs --json`, { rss: 40_000 }),
        // a codex worker the Claude session started: its own session, nested under the shell
        row(220, 215, `node ${HOME}/.nvm/lib/node_modules/@openai/codex/bin/codex.js exec`, { rss: 50_000 }),
        row(221, 220, `${HOME}/.nvm/lib/node_modules/@openai/codex/vendor/codex exec`, { cpu: 2, rss: 60_000 }),
        // an orphaned cursor-agent worker with an MCP server, nine days old
        row(300, 1, `node ${HOME}/.local/share/cursor-agent/versions/2026.09.01/index.js --worker`, {
            rss: 400_000,
            age: 9 * DAY,
        }),
        row(301, 300, `node ${HOME}/.bun/bin/playwright-mcp`, { rss: 90_000, age: 9 * DAY }),
        // an MCP server whose session died, a tool shell whose session died, and a launchd-run MCP gateway
        row(310, 1, `node ${HOME}/.bun/bin/reddit-mcp-server`, { rss: 20_000, age: 3 * DAY }),
        row(
            320,
            1,
            `/bin/zsh -c source ${HOME}/.claude/shell-snapshots/snapshot-zsh-2.sh && export CODEX_COMPANION_SESSION_ID='${S3}'`,
            { rss: 32, age: 6 * DAY }
        ),
        row(
            330,
            1,
            `${HOME}/Applications/GenesisTools.app/Contents/MacOS/GenesisTools ${HOME}/.bun/bin/bun ${GT}/tools mcp-manager gateway start`,
            { age: 10 * DAY }
        ),
        // a `tools claude run` whose agent exited two days ago (a resume picker nobody answered)
        row(400, 110, `bun run ${GT}/src/claude/index.ts run personal --resume notes`, { rss: 300_000, age: 2 * DAY }),
        // not agents: an Electron app named like one and a proxy script under ~/.grok
        row(500, 1, "/Applications/Grok Bot.app/Contents/MacOS/Grok Bot", { rss: 330_000 }),
        row(510, 1, `${HOME}/.bun/bin/bun ${HOME}/.grok/grok-proxy.ts up`),
        // an idle grok session in another project
        row(600, 110, `${HOME}/.local/bin/grok`, { rss: 120_000, age: 5 * HOUR }),
    ];
}

const SESSIONS: SessionLike[] = [
    { provider: "claude", sessionId: S1, title: "agents window", cwd: `${GT}`, mtime: NOW - 2 * MIN },
    { provider: "grok", sessionId: S2, title: "old notes", cwd: "/Users/alice/Projects/notes", mtime: NOW - 4 * HOUR },
];

function input(overrides: Partial<BuildInput> = {}): BuildInput {
    return {
        table: table(),
        now: NOW,
        own: new Set([216, 215, 210, 202, 201, 200, 110, 100]),
        cwdOf: (pid) => (pid === 600 ? "/Users/alice/Projects/notes" : pid === 210 || pid === 220 ? GT : null),
        sessions: SESSIONS,
        launchd: new Map([[330, "com.example.mcp-gateway"]]),
        energy: null,
        realpath: (path) => path,
        ...overrides,
    };
}

describe("classifyCommand", () => {
    test("agent CLIs by their binary or entry script, with the session id the argv names", () => {
        expect(classifyCommand(`${HOME}/.bun/bin/claude --resume ${S1}`)).toEqual({
            kind: "agent",
            provider: "claude",
            label: "claude",
            sessionId: S1,
        });
        expect(classifyCommand(`${HOME}/.local/share/claude/versions/2.1.112 -p hi`).provider).toBe("claude");
        expect(classifyCommand(`${HOME}/node_modules/@openai/codex/vendor/codex resume ${S2}`)).toMatchObject({
            provider: "codex",
            sessionId: S2,
        });
        expect(classifyCommand(`node ${HOME}/.local/share/cursor-agent/versions/1.2/index.js`).provider).toBe(
            "cursor-agent"
        );
        expect(classifyCommand(`bash ${HOME}/.local/bin/cursor-agent --print`).provider).toBe("cursor-agent");
        expect(classifyCommand("/usr/local/bin/grok").provider).toBe("grok");
    });

    test("apps and scripts that only share a name are not agents", () => {
        expect(classifyCommand("/Applications/Grok Bot.app/Contents/MacOS/Grok Bot").kind).toBe("other");
        expect(classifyCommand(`${HOME}/.bun/bin/bun ${HOME}/.grok/grok-proxy.ts up`).kind).toBe("other");
        expect(
            classifyCommand("/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Renderer).app/x").kind
        ).toBe("other");
    });

    test("GenesisTools wrappers, MCP doors and other tools, through gt-* launchers and the app launcher face", () => {
        expect(
            classifyCommand(`${HOME}/.genesis-tools/bin/gt-cc --preload x.ts ${GT}/src/cc/index.ts run work`)
        ).toMatchObject({
            kind: "wrapper",
            provider: "claude",
            label: "tools cc run",
        });
        expect(classifyCommand(`bun ${GT}/tools codex resume ${S2}`)).toMatchObject({
            kind: "wrapper",
            provider: "codex",
            sessionId: S2,
        });
        expect(classifyCommand(`bun ${GT}/tools claude mcp`)).toMatchObject({ kind: "mcp", label: "tools claude mcp" });
        expect(
            classifyCommand(
                `${HOME}/Applications/GenesisTools.app/Contents/MacOS/GenesisTools bun ${GT}/tools mcp-manager gateway start`
            ).kind
        ).toBe("mcp");
        expect(classifyCommand(`bun ${GT}/tools hub procs`)).toMatchObject({ kind: "tools", label: "tools hub procs" });
        expect(classifyCommand(`bun ${GT}/.worktrees/feat-x/src/claude/index.ts resume ${S1}`).kind).toBe("wrapper");
    });

    test("MCP servers get the name that says which one", () => {
        expect(classifyCommand(`node ${HOME}/.bun/bin/context7-mcp`).label).toBe("context7-mcp");
        expect(classifyCommand(`node ${HOME}/.bun/bin/graft mcp`).label).toBe("graft mcp");
        expect(classifyCommand(`node ${HOME}/.bridge/bridgememory-mcp/server.cjs`).label).toBe("bridgememory-mcp");
        expect(classifyCommand("node /opt/x/node_modules/mcporter/dist/cli.js daemon start").label).toBe("mcporter");
        expect(classifyCommand("/usr/bin/python3 -m http.server").kind).toBe("other");
    });

    test("a Claude tool shell carries its session id", () => {
        expect(
            classifyCommand(`/bin/zsh -c source ${HOME}/.claude/shell-snapshots/s.sh && export X_SESSION_ID='${S3}'`)
        ).toEqual({
            kind: "shell",
            provider: "claude",
            label: "claude tool shell",
            sessionId: S3,
        });
    });

    test("argvSessionId takes uuids only, never a resume query", () => {
        expect(argvSessionId("claude --resume agents-window")).toBeNull();
        expect(argvSessionId(`claude --resume=${S1}`)).toBe(S1);
        expect(argvSessionId(`claude -r '${S2}'`)).toBe(S2);
    });
});

describe("buildProcsReport", () => {
    const report = buildProcsReport(input());
    const group = (pid: number) => report.groups.find((entry) => entry.rootPid === pid);

    test("one group per agent session, wrapper leftover and orphan; unrelated processes stay out", () => {
        expect(report.groups.map((entry) => entry.rootPid).sort((a, b) => a - b)).toEqual([
            210, 220, 300, 310, 320, 330, 400, 600,
        ]);
        expect(group(500)).toBeUndefined();
        expect(group(510)).toBeUndefined();
    });

    test("the live Claude tree holds its MCP servers and tool shell but not the codex worker it started", () => {
        const claude = group(210);

        expect(claude?.processes.map((entry) => entry.pid)).toEqual([210, 211, 212, 213, 214, 215, 216]);
        expect(claude?.processes.find((entry) => entry.pid === 214)?.depth).toBe(2);
        expect(claude?.totals.rssKb).toBe(1_000_000 + 80_000 + 70_000 + 30_000 + 150_000 + 3_000 + 40_000);
        expect(claude?.totals.cpu).toBe(10.5);
        expect(claude?.wrapperPid).toBe(201);
        expect(claude?.orphan).toBe(false);
        expect(claude?.parent).toEqual({ pid: 202, label: "zsh", alive: true });
        expect(claude?.session).toMatchObject({ sessionId: S1, title: "agents window", match: "argv" });
        expect(claude?.own).toBe(true);
    });

    test("the codex npm shim and its native binary are one session, nested under the Claude one", () => {
        const codex = group(220);

        expect(codex?.processes.map((entry) => entry.pid)).toEqual([220, 221]);
        expect(codex?.parentAgentPid).toBe(210);
        expect(group(221)).toBeUndefined();
    });

    test("orphans: an adopted agent with its MCP server, an adopted MCP server, an adopted tool shell", () => {
        expect(group(300)).toMatchObject({
            kind: "agent",
            provider: "cursor-agent",
            orphan: true,
            orphanReason: "its parent is gone (PPID 1)",
        });
        expect(group(300)?.processes.map((entry) => entry.pid)).toEqual([300, 301]);
        expect(group(310)).toMatchObject({ kind: "orphan", label: "reddit-mcp-server", orphan: true });
        expect(group(320)).toMatchObject({ kind: "orphan", orphan: true });
        expect(group(320)?.session).toMatchObject({ sessionId: S3, match: "shell", title: null });
        expect(report.totals.orphans).toBe(3);
        expect(report.groups.slice(0, 3).every((entry) => entry.orphan)).toBe(true);
    });

    test("a launchd job is adopted on purpose and never an orphan", () => {
        expect(group(330)).toMatchObject({ orphan: false, launchdLabel: "com.example.mcp-gateway" });
        expect(group(330)?.orphanReason).toContain("launchd job");
    });

    test("a wrapper with no agent below it is listed as left over and idle", () => {
        expect(group(400)).toMatchObject({
            kind: "wrapper",
            provider: "claude",
            idle: true,
            idleReason: "no agent process runs below it",
            suspended: false,
        });
    });

    test("a stopped root (ps state T) is suspended in its shell, not left over", () => {
        const base = input();
        const stopped = buildProcsReport({
            ...base,
            table: base.table.map((entry) => (entry.pid === 400 ? { ...entry, stat: "T" } : entry)),
        });
        const wrapper = stopped.groups.find((entry) => entry.rootPid === 400);

        expect(wrapper).toMatchObject({ kind: "wrapper", idle: true, suspended: true });
        expect(wrapper?.idleReason).toContain("suspended in its shell");
    });

    test("idle agents: the folder's newest session wrote nothing for hours and the tree is quiet", () => {
        expect(group(600)).toMatchObject({ idle: true, session: { sessionId: S2, match: "cwd" } });
        expect(group(600)?.idleReason).toBe("its session wrote nothing for 4 h");
        expect(group(210)?.idle).toBe(false);
    });

    test("an agent whose wrapper lost its parent is an orphan too", () => {
        const rows = table().map((entry) => (entry.pid === 200 ? { ...entry, ppid: 1 } : entry));
        const orphaned = buildProcsReport(input({ table: rows }));

        expect(orphaned.groups.find((entry) => entry.rootPid === 210)?.orphanReason).toBe(
            "the tools cc run that started it (200) lost its parent (PPID 1)"
        );
    });

    test("energy sums per tree when asked for, and a pid outside the sample counts as zero", () => {
        const withEnergy = buildProcsReport(
            input({
                energy: new Map([
                    [210, 4.5],
                    [211, 0.5],
                ]),
            })
        );

        expect(withEnergy.energy).toBe(true);
        expect(withEnergy.groups.find((entry) => entry.rootPid === 210)?.totals.energy).toBe(5);
        expect(report.groups[0]?.totals.energy).toBeNull();
    });

    test("a folder match never takes a session another process names by id", () => {
        const rows = [...table(), row(700, 110, `${HOME}/.bun/bin/claude`, { age: 10 * MIN })];
        const matched = buildProcsReport(
            input({ table: rows, cwdOf: (pid) => (pid === 700 || pid === 210 ? GT : null) })
        );

        expect(matched.groups.find((entry) => entry.rootPid === 700)?.session).toBeNull();
    });
});

function fakeSources(rows: PsRow[], own = new Set<number>([9999])): ProcsSources {
    return {
        table: async () => rows,
        cwdOf: () => null,
        sessions: async () => [],
        launchd: async () => new Map([[330, "com.example.mcp-gateway"]]),
        energy: async () => new Map(),
        own: () => own,
        realpath: (path) => path,
        now: () => NOW,
    };
}

/** A process table in memory: signals are recorded, and each pid dies on the signals listed for it. */
function fakeOps(
    rows: PsRow[],
    diesOn: Record<number, "SIGTERM" | "SIGKILL" | "never">
): SignalOps & { sent: string[] } {
    const alive = new Set(rows.map((entry) => entry.pid));
    let clock = NOW;
    const sent: string[] = [];
    return {
        sent,
        signal: (pid, signal) => {
            sent.push(`${signal} ${pid}`);
            const rule = diesOn[pid] ?? "SIGTERM";

            if (rule === signal || (rule === "SIGTERM" && signal === "SIGKILL")) {
                alive.delete(pid);
            }
        },
        alive: (pid) => alive.has(pid),
        identity: (pids) =>
            new Map(
                rows
                    .filter((entry) => pids.includes(entry.pid) && alive.has(entry.pid))
                    .map((entry) => [
                        entry.pid,
                        { startedAt: entry.startTime?.toISOString() ?? null, command: entry.command },
                    ])
            ),
        sleep: async (ms) => {
            clock += ms;
        },
        now: () => clock,
    };
}

describe("stopTree", () => {
    test("SIGTERM to the root first, then its tree; nothing else is signalled", async () => {
        const rows = table();
        const ops = fakeOps(rows, {});
        const outcome = await stopTree({ pid: 300, sources: fakeSources(rows), ops });

        expect(outcome).toMatchObject({ stopped: true, signal: "TERM", pids: [300, 301], survivors: [], reason: null });
        expect(ops.sent).toEqual(["SIGTERM 300", "SIGTERM 301"]);
    });

    test("SIGKILL after the grace period for what ignored SIGTERM", async () => {
        const rows = table();
        const ops = fakeOps(rows, { 301: "SIGKILL" });
        const outcome = await stopTree({ pid: 300, graceMs: 1_000, sources: fakeSources(rows), ops });

        expect(outcome).toMatchObject({ stopped: true, signal: "KILL", survivors: [] });
        expect(ops.sent).toEqual(["SIGTERM 300", "SIGTERM 301", "SIGKILL 301"]);
    });

    test("a pid that now belongs to another process is never killed", async () => {
        const rows = table();
        const ops = fakeOps(rows, { 301: "never" });
        const identity = ops.identity;
        let calls = 0;
        ops.identity = (pids) => {
            calls++;
            const found = identity(pids);

            // The second look (before SIGKILL) sees pid 301 reused by a new process.
            if (calls > 1 && found.has(301)) {
                found.set(301, { startedAt: new Date(NOW).toISOString(), command: "/usr/bin/vim notes.md" });
            }

            return found;
        };
        const outcome = await stopTree({ pid: 300, graceMs: 1_000, sources: fakeSources(rows), ops });

        // The process that had 301 is gone (the pid was handed on), so the tree counts as stopped.
        expect(ops.sent).toEqual(["SIGTERM 300", "SIGTERM 301"]);
        expect(outcome).toMatchObject({ stopped: true, signal: "TERM", survivors: [] });
    });

    test("a pid reused between the report and the first signal gets no signal at all", async () => {
        const rows = table();
        const ops = fakeOps(rows, {});
        ops.identity = (pids) =>
            new Map(pids.map((pid) => [pid, { startedAt: new Date(NOW).toISOString(), command: "/usr/bin/vim" }]));
        const outcome = await stopTree({ pid: 310, sources: fakeSources(rows), ops });

        expect(ops.sent).toEqual([]);
        expect(outcome).toMatchObject({ stopped: false, signal: null });
        expect(outcome.reason).toContain("already exited or now belongs to another process");
    });

    test("a member pid stops only its own subtree", async () => {
        const rows = table();
        const ops = fakeOps(rows, {});
        const outcome = await stopTree({ pid: 213, sources: fakeSources(rows), ops });

        expect(outcome.pids).toEqual([213, 214]);
        expect(ops.sent).toEqual(["SIGTERM 213", "SIGTERM 214"]);
    });

    test("refuses its own tree, pid 1, a non-agent process and a launchd job, and sends nothing", async () => {
        const rows = table();
        const ops = fakeOps(rows, {});
        const sources = fakeSources(rows, new Set([216, 215, 210, 202, 201, 200, 110, 100]));

        for (const pid of [210, 216, 1, 500, 330]) {
            const outcome = await stopTree({ pid, sources, ops });
            expect(outcome.stopped).toBe(false);
            expect(outcome.reason).not.toBeNull();
        }

        expect(ops.sent).toEqual([]);
        const report = await readProcsReport({ sources });
        expect(refusal(report, 210, sources.own())).toContain("runs the command that asked");
        expect(refusal(report, 500, sources.own())).toContain("is not an agent process");
        expect(refusal(report, 330, sources.own())).toContain("launchctl");
    });

    test("stopOrphans stops only the orphans that were confirmed", async () => {
        const rows = table();
        const ops = fakeOps(rows, {});
        const outcomes = await stopOrphans({ only: [310, 320], sources: fakeSources(rows), ops });

        expect(outcomes.map((outcome) => outcome.pid).sort()).toEqual([310, 320]);
        expect(ops.sent.sort()).toEqual(["SIGTERM 310", "SIGTERM 320"]);
    });
});

describe("sources parsers", () => {
    test("launchctl list: running jobs only", () => {
        const jobs = parseLaunchctlList(
            "PID\tStatus\tLabel\n330\t0\tcom.example.mcp-gateway\n-\t0\tcom.example.idle\n"
        );

        expect([...jobs]).toEqual([[330, "com.example.mcp-gateway"]]);
    });

    test("top: the second sample's PID POWER table", () => {
        const stdout = [
            "PID    POWER",
            "210    0.0",
            "",
            "Processes: 700 total",
            "PID    POWER",
            "210    4.7 ",
            "300    12.5",
            "",
        ].join("\n");

        expect([...parseTopPower(stdout)]).toEqual([
            [210, 4.7],
            [300, 12.5],
        ]);
    });
});
