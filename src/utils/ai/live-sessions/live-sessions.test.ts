import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenDialog } from "@genesiscz/utils/agents/dialogs/types";
import { CmuxUnresponsiveError } from "@genesiscz/utils/cmux/lib/health";
import type { CmuxTreeBackoff } from "@genesiscz/utils/cmux/lib/tree-backoff";
import type { LiveSurface } from "@genesiscz/utils/cmux/live-layout";
import type { LiveAgentSurface } from "@genesiscz/utils/cmux/live-surfaces";
import { SurfaceInputError } from "@genesiscz/utils/cmux/surface-input";
import { SafeJSON } from "@genesiscz/utils/json";
import type { ProcessEntry } from "@genesiscz/utils/process/processes";
import { fleetEntryOf, readFleetView } from "./fleet";
import { liveSurfacesNow, type SessionInputDeps, sendToSession } from "./input";
import {
    joinLiveSessions,
    type LiveAgentProcess,
    type LiveSessionReads,
    type LiveSessionRow,
    liveAgentProcesses,
    liveSessionReads,
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

    it("a wedged cmux answers within the tree timeout on the first refresh and from the backoff on the second", async () => {
        const TREE_MS = 50;
        let treeCalls = 0;
        let record: CmuxTreeBackoff | null = null;
        const tree = liveSessionReads({
            timeoutMs: TREE_MS,
            // A cmux that takes the call and never answers.
            run: () => {
                treeCalls++;
                return new Promise<unknown>(() => {});
            },
            probe: async () => {
                throw new CmuxUnresponsiveError("cmux tree", {
                    state: "socket-dead",
                    appPid: 42,
                    probes: { ping: { ok: false, ms: 1 }, identify: { ok: false, ms: 0 } },
                });
            },
            backoff: { read: () => record, write: (next) => (record = next) },
            appPid: () => 42,
        }).tree;
        const reads = { ...fakeReads({ journalTty: "ttys001", processes: [psEntry(10, "claude")] }), tree };
        const refresh = async () => {
            const started = performance.now();
            const rows = await locateLiveSessions({ reads });
            return { rows, ms: performance.now() - started };
        };

        const first = await refresh();
        expect(treeCalls).toBe(1);
        expect(first.ms).toBeLessThan(TREE_MS + 1_000);
        // No surface was read, so the process answers alone; the failure is not a tab list.
        expect(first.rows.map((row) => [row.match, row.process?.pid ?? null, row.surface])).toEqual([
            ["process", 10, null],
        ]);
        expect(record).toMatchObject({ failures: 1, state: "socket-dead" });

        const second = await refresh();
        expect(treeCalls).toBe(1);
        expect(second.ms).toBeLessThan(TREE_MS);
        expect(second.rows).toEqual(first.rows);
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

describe("sendToSession: the one guarded session input", () => {
    const TMUX_JOIN = {
        pane: "%41",
        session: "work-claude",
        surface: "surface:7",
        paneTty: "ttys041",
        sessionCreatedMs: 0,
    };
    const plain = liveSurface(SESSION_A, "surface:7", "ttys007");
    const viaTmux: LiveAgentSurface = { ...plain, tmux: TMUX_JOIN };
    const QUESTION: OpenDialog = { kind: "decision", question: "Which one?", signal: "hook" };

    /** Edges that pass every guard; a case overrides the one it tests. `calls` holds each cmux argv written. */
    function edges(overrides: SessionInputDeps = {}) {
        const calls: string[][] = [];
        const deps: SessionInputDeps = {
            surfaces: async () => ({ ok: true, surfaces: [plain] }),
            agentsOnTty: () => new Set(["claude"]),
            stillShown: async () => ({ ok: true }),
            openDialog: async () => null,
            run: async (args) => {
                calls.push(args);
                return { code: 0, stdout: "", stderr: "" };
            },
            ...overrides,
        };
        return { calls, deps };
    }

    it("delivered: pastes into the verified surface UUID, submits in the same call, then presses the keys", async () => {
        const { calls, deps } = edges();
        const outcome = await sendToSession(
            { sessionId: SESSION_A, text: 'say "hi" \\n', submit: true, keys: ["escape"] },
            deps
        );

        expect(outcome).toMatchObject({ delivered: true, surface: "surface:7" });
        expect(calls).toEqual([
            ["paste", "--surface", "uuid-surface:7", "--submit", "--", 'say "hi" \\n'],
            ["send-key", "--surface", "uuid-surface:7", "escape"],
        ]);
    });

    it("not-found: no live surface runs the session, or it runs another agent than the one asked for", async () => {
        const { calls, deps } = edges({ surfaces: async () => ({ ok: true, surfaces: [] }) });

        expect(await sendToSession({ sessionId: SESSION_A, text: "hi" }, deps)).toMatchObject({
            delivered: false,
            reason: "not-found",
        });
        const grok = await sendToSession({ sessionId: SESSION_A, text: "hi", provider: "grok" }, edges().deps);
        expect(grok).toMatchObject({ delivered: false, reason: "not-found" });
        // A surface without its UUID: after a cmux restart its ref can name another terminal.
        const noUuid = edges({
            surfaces: async () => ({ ok: true, surfaces: [{ ...plain, surface: { ...plain.surface, id: null } }] }),
        });
        expect(await sendToSession({ sessionId: SESSION_A, text: "hi" }, noUuid.deps)).toMatchObject({
            reason: "not-found",
            detail: expect.stringContaining("no surface UUID"),
        });
        expect([...calls, ...noUuid.calls]).toEqual([]);
    });

    it("tty-shared: the tab runs another agent, or this agent and another one, and nothing is written", async () => {
        const other = edges({ agentsOnTty: () => new Set(["codex"]) });
        const both = edges({ agentsOnTty: () => new Set(["claude", "codex"]) });

        expect(await sendToSession({ sessionId: SESSION_A, text: "hi" }, other.deps)).toMatchObject({
            reason: "tty-shared",
            detail: expect.stringContaining("it runs codex, not claude"),
        });
        expect(await sendToSession({ sessionId: SESSION_A, text: "hi" }, both.deps)).toMatchObject({
            reason: "tty-shared",
            detail: expect.stringContaining("it also runs codex"),
        });
        expect([...other.calls, ...both.calls]).toEqual([]);
    });

    it("tmux-hidden: the surface shows another tmux pane, checked again right before the write", async () => {
        const hidden = edges({
            surfaces: async () => ({ ok: true, surfaces: [viaTmux] }),
            stillShown: async () => ({ ok: false, reason: "tmux shows another pane of work-claude now" }),
        });
        expect(await sendToSession({ sessionId: SESSION_A, text: "hi" }, hidden.deps)).toMatchObject({
            reason: "tmux-hidden",
        });

        // The pane was shown at the first check and switched while the dialog guard read the session.
        let checks = 0;
        const switched = edges({
            surfaces: async () => ({ ok: true, surfaces: [viaTmux] }),
            stillShown: async () => (++checks === 1 ? { ok: true } : { ok: false, reason: "switched" }),
        });
        expect(await sendToSession({ sessionId: SESSION_A, text: "hi" }, switched.deps)).toMatchObject({
            reason: "tmux-hidden",
        });
        expect(checks).toBe(2);
        expect([...hidden.calls, ...switched.calls]).toEqual([]);
    });

    it("dialog-open: an open dialog stops the input; a forced dialog answer skips that guard and presses with --force", async () => {
        const open = edges({ openDialog: async () => QUESTION });
        expect(await sendToSession({ sessionId: SESSION_A, text: "hi" }, open.deps)).toMatchObject({
            delivered: false,
            reason: "dialog-open",
            dialog: QUESTION,
        });
        expect(open.calls).toEqual([]);

        const answer = edges({
            openDialog: async () => {
                throw new Error("a dialog answer must not ask the dialog guard");
            },
        });
        const pressed = await sendToSession(
            { sessionId: SESSION_A, keys: [{ text: "2" }, "enter"], force: true },
            answer.deps
        );
        expect(pressed.delivered).toBe(true);
        expect(answer.calls).toEqual([
            ["send", "--surface", "uuid-surface:7", "--force", "--", "2"],
            ["send-key", "--surface", "uuid-surface:7", "--force", "enter"],
        ]);
    });

    it("draft-present: cmux refuses the paste while the prompt holds a draft, and no key is pressed after it", async () => {
        const { calls, deps } = edges({
            run: async (args) => {
                calls.push(args);
                return {
                    code: 1,
                    stdout: "",
                    stderr: "Error: paste: the agent prompt in surface:7 holds text someone is typing, so nothing was sent.",
                };
            },
        });

        expect(await sendToSession({ sessionId: SESSION_A, text: "hi", keys: ["enter"] }, deps)).toMatchObject({
            delivered: false,
            reason: "draft-present",
            mayHaveLanded: false,
        });
        expect(calls).toHaveLength(1);
    });

    it("a cmux failure its guard does not name is an error, never a draft or dialog refusal", async () => {
        const failing = (stderr: string) =>
            edges({
                run: async (args) => {
                    if (args[0] === "send-key") {
                        return { code: 1, stdout: "", stderr };
                    }

                    return { code: 0, stdout: "", stderr: "" };
                },
            }).deps;

        const missing = sendToSession(
            { sessionId: SESSION_A, text: "hi", keys: ["enter"] },
            failing("Surface not found")
        );
        await expect(missing).rejects.toBeInstanceOf(SurfaceInputError);
        await expect(missing).rejects.toMatchObject({ mayHaveLanded: true });

        expect(
            await sendToSession(
                { sessionId: SESSION_A, keys: ["enter"] },
                failing("Error: send-key: surface:7 is waiting on a question or dialog, so nothing was sent.")
            )
        ).toMatchObject({ delivered: false, reason: "dialog-open", mayHaveLanded: false });
    });

    it("timeout: a cmux that does not answer the tree read is a refusal, never not-found", async () => {
        const silent = liveSurfacesNow({
            tree: {
                timeoutMs: 50,
                run: () => new Promise<unknown>(() => {}),
                probe: async () => {
                    throw new CmuxUnresponsiveError("cmux tree", {
                        state: "socket-dead",
                        appPid: 42,
                        probes: { ping: { ok: false, ms: 1 }, identify: { ok: false, ms: 0 } },
                    });
                },
                backoff: null,
                appPid: () => 42,
            },
        });
        const { calls, deps } = edges({ surfaces: () => silent });

        expect(await sendToSession({ sessionId: SESSION_A, text: "hi" }, deps)).toMatchObject({
            delivered: false,
            reason: "timeout",
            detail: expect.stringContaining("cmux did not answer"),
        });
        expect(calls).toEqual([]);
    });

    it("timeout: a paste past its deadline may have landed, so the keys after it are not pressed", async () => {
        const { calls, deps } = edges({
            run: async (args) => {
                calls.push(args);
                return { code: -1, stdout: "", stderr: "cmux paste timed out after 30000 ms", timedOut: true };
            },
        });

        expect(await sendToSession({ sessionId: SESSION_A, text: "hi", keys: ["enter"] }, deps)).toMatchObject({
            delivered: false,
            reason: "timeout",
            mayHaveLanded: true,
        });
        expect(calls).toHaveLength(1);
    });
});
