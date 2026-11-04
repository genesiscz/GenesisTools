import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveSurface } from "@genesiscz/utils/cmux/live-layout";
import type { LiveAgentSurface } from "@genesiscz/utils/cmux/live-surfaces";
import { SafeJSON } from "@genesiscz/utils/json";
import type { ProcessEntry } from "@genesiscz/utils/process/processes";
import { fleetEntryOf, readFleetView } from "./fleet";
import {
    joinLiveSessions,
    type LiveAgentProcess,
    type LiveSessionReads,
    type LiveSessionRow,
    liveAgentProcesses,
    locateLiveSessions,
} from "./locate";
import { FLEET_PHASES, fleetPhaseLabel } from "./phase";

const UID = 501;
const SESSION_A = "0199aaaa-0000-7000-8000-00000000000a";
const SESSION_B = "0199bbbb-0000-7000-8000-00000000000b";

function surfaceOf(ref: string, tty: string | null): LiveSurface {
    return {
        ref,
        id: `uuid-${ref}`,
        tty,
        workspace: "workspace:1",
        workspaceId: "uuid-workspace:1",
        window: "window:1",
        title: "fixture tab",
        workspaceTitle: null,
    };
}

function liveSurface(sessionId: string, ref: string, tty: string | null): LiveAgentSurface {
    return { sessionId, agent: "claude", surface: surfaceOf(ref, tty), cwd: "/fixture", tmux: null, lastSeenAt: 1 };
}

function agentProcess(pid: number, tty: string | null, argvSessionId: string | null = null): LiveAgentProcess {
    return { pid, ppid: 1, tty, provider: "claude", argvSessionId, startMs: 1, command: "claude" };
}

function psEntry(pid: number, command: string, extra: Partial<ProcessEntry> = {}): ProcessEntry {
    return {
        pid,
        ppid: 1,
        pgid: pid,
        uid: UID,
        name: command.split(" ")[0] ?? command,
        command,
        tty: "ttys001",
        startMs: 1,
        zombie: false,
        state: "S",
        ...extra,
    };
}

describe("joinLiveSessions", () => {
    it("joins a surface to the agent on its tty, and keeps a surface without a pid and a pid without a surface", () => {
        const rows = joinLiveSessions({
            surfaces: [liveSurface(SESSION_A, "surface:1", "ttys001"), liveSurface(SESSION_B, "surface:2", "ttys002")],
            processes: [agentProcess(10, "ttys001"), agentProcess(30, null, "0199cccc-0000-7000-8000-00000000000c")],
        });

        expect(
            rows.map((row) => [row.sessionId, row.match, row.process?.pid ?? null, row.surface?.surface.ref ?? null])
        ).toEqual([
            [SESSION_A, "journal", 10, "surface:1"],
            [SESSION_B, "journal", null, "surface:2"],
            ["0199cccc-0000-7000-8000-00000000000c", "argv", 30, null],
        ]);
    });

    it("never guesses between two agents of one kind on one tty, unless a command line names the session", () => {
        const surface = liveSurface(SESSION_A, "surface:1", "ttys001");
        const guess = joinLiveSessions({
            surfaces: [surface],
            processes: [agentProcess(10, "ttys001"), agentProcess(11, "ttys001")],
        });
        expect(guess[0].process).toBeNull();
        expect(guess.filter((row) => row.match === "process")).toHaveLength(2);

        const named = joinLiveSessions({
            surfaces: [surface],
            processes: [agentProcess(10, "ttys001"), agentProcess(11, "ttys001", SESSION_A)],
        });
        expect(named[0].process?.pid).toBe(11);
    });

    it("joins a --via-tmux session through its pane's tty, and marks a title-found session", () => {
        const viaTmux: LiveAgentSurface = {
            ...liveSurface(SESSION_A, "surface:1", "ttys001"),
            tmux: { pane: "%1", session: "work", surface: "surface:1", paneTty: "ttys009", sessionCreatedMs: 0 },
            transcriptPath: "/fixture/a.jsonl",
        };
        const [row] = joinLiveSessions({ surfaces: [viaTmux], processes: [agentProcess(10, "ttys009")] });
        expect(row).toMatchObject({ match: "title", transcriptPath: "/fixture/a.jsonl", process: { pid: 10 } });
    });
});

describe("liveAgentProcesses", () => {
    it("keeps this user's agent binaries, one per launcher and child pair, and drops services and wrappers", () => {
        const found = liveAgentProcesses(
            [
                psEntry(10, `claude --resume ${SESSION_A}`),
                psEntry(11, "claude", { ppid: 10 }),
                psEntry(12, "claude", { uid: 0 }),
                psEntry(13, "claude", { zombie: true }),
                psEntry(14, "codex mcp", { tty: null }),
                psEntry(15, "/bin/zsh -l"),
            ],
            UID
        );

        expect(found.map((proc) => [proc.pid, proc.argvSessionId])).toEqual([[10, SESSION_A]]);
    });
});

function fakeReads(input: { journalTty: string; processes: ProcessEntry[] }): LiveSessionReads {
    return {
        tree: async () => ({
            caller: "surface:9",
            callerId: "uuid-surface:9",
            surfaces: new Map([["surface:1", surfaceOf("surface:1", input.journalTty)]]),
        }),
        tmux: async () => new Map(),
        journal: () => [
            {
                sessionId: SESSION_B,
                provider: "claude",
                workspaceId: "uuid-workspace:1",
                surfaceId: "uuid-surface:1",
                workspaceRef: "workspace:1",
                paneRef: null,
                surfaceRef: "surface:1",
                windowRef: null,
                tmuxPane: null,
                cwd: "/fixture",
                at: 5,
            },
        ],
        pins: async () => new Map(),
        processes: () => input.processes,
        uid: () => UID,
        titles: () => [],
    };
}

describe("locateLiveSessions", () => {
    it("reads each source once and returns the journal session with its pid and a headless agent without a surface", async () => {
        const rows = await locateLiveSessions({
            reads: fakeReads({
                journalTty: "ttys001",
                processes: [psEntry(10, "claude"), psEntry(20, `claude -p --resume ${SESSION_A}`, { tty: null })],
            }),
        });

        expect(rows.map((row) => [row.sessionId, row.match, row.process?.pid ?? null, row.surface !== null])).toEqual([
            [SESSION_B, "journal", 10, true],
            [SESSION_A, "argv", 20, false],
        ]);
    });
});

describe("FLEET_PHASES", () => {
    it("labels every phase, and says stalled only for a running turn", () => {
        expect(Object.keys(FLEET_PHASES).sort()).toEqual(["idle", "interrupted", "thinking", "tool", "waiting"]);
        expect(fleetPhaseLabel({ phase: "tool", stalled: true })).toBe("stalled");
        expect(fleetPhaseLabel({ phase: "waiting", stalled: true })).toBe("waiting");
        expect(fleetPhaseLabel({ phase: null, stalled: false })).toBe("unknown");
    });
});

const dir = mkdtempSync(join(tmpdir(), "live-sessions-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A Claude transcript whose turn sits on an open AskUserQuestion call: the session waits for its user. */
function waitingTranscript(): string {
    const path = join(dir, `${SESSION_A}.jsonl`);
    const at = new Date().toISOString();
    const lines = [
        { type: "user", timestamp: at, message: { role: "user", content: "ship it" } },
        {
            type: "assistant",
            timestamp: at,
            message: {
                id: "msg_1",
                role: "assistant",
                stop_reason: "tool_use",
                content: [
                    {
                        type: "tool_use",
                        id: "q1",
                        name: "AskUserQuestion",
                        input: { questions: [{ question: "Ship it?" }] },
                    },
                ],
            },
        },
    ];
    writeFileSync(path, `${lines.map((line) => SafeJSON.stringify(line)).join("\n")}\n`);
    return path;
}

describe("a session that waits on a question", () => {
    it("reads waiting, not idle, in the fleet view", async () => {
        const filePath = waitingTranscript();
        const row: LiveSessionRow = {
            provider: "claude",
            sessionId: SESSION_A,
            match: "title",
            surface: liveSurface(SESSION_A, "surface:1", "ttys001"),
            process: null,
            cwd: "/fixture",
            transcriptPath: filePath,
        };
        const entry = await fleetEntryOf({
            row,
            transcript: { provider: "claude", source: "native", sessionId: SESSION_A, filePath },
        });
        expect(entry).toMatchObject({ phase: "waiting", label: "waiting", stalled: false });
        expect(entry.activity?.question).toBe("Ship it?");

        const [viaView] = await readFleetView({ rows: [row] });
        expect(viaView.label).toBe("waiting");
    });
});
