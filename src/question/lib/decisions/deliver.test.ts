import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CodexSessionMeta, CodexSessionStore } from "@app/codex/lib/store";
import { defaultGrokLeaderSocket, type GrokLeaderClient, matchLeaderSession } from "@app/grok/lib/leader";
import { listSessionMessages } from "@genesiscz/utils/agent-sessions/message-queue";
import { GrokAcpRefusedError } from "@genesiscz/utils/ai/grok/acp";
import { withTimeout } from "@genesiscz/utils/async";
import { claudeSessionsDir, listClaudeSessionInventory } from "@genesiscz/utils/claude/peer-message";
import { standInSender } from "@genesiscz/utils/claude/peer-sender";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    type DeliverDeps,
    DeliveryUnknownError,
    deliverToSession as deliverLive,
    resolveDeliveryTarget as resolveLive,
} from "./deliver";
import { livePaneTargets, noNativeReceivers, noPaneTargets } from "./deliver.fixtures";

// Every test here scripts the machine: the live Claude peer registry and the Grok leader sockets stay out unless a
// test passes its own.
const deliverToSession = (request: Parameters<typeof deliverLive>[0], deps: DeliverDeps = {}) =>
    deliverLive(request, { ...noNativeReceivers, ...deps });
const resolveDeliveryTarget = (request: Parameters<typeof resolveLive>[0], deps: DeliverDeps = {}) =>
    resolveLive(request, { ...noNativeReceivers, ...deps });

describe("delivery routes", () => {
    function spy(result: { success: boolean; stdout: string; stderr?: string }) {
        const calls: string[][] = [];
        const prompts: string[] = [];
        const runTool = async (args: string[]) => {
            calls.push(args);
            if (args.includes("--prompt-file")) {
                prompts.push(readFileSync(args[args.indexOf("--prompt-file") + 1], "utf8"));
            }
            return { stderr: "", ...result };
        };
        return { calls, prompts, runTool };
    }

    test("owned Claude and Grok workers resume without cmux and require exact completed-turn receipts", async () => {
        for (const provider of ["claude", "grok"] as const) {
            const calls: string[][] = [];
            let promptFile = "";
            const result = await deliverToSession(
                {
                    session: "fixture-session",
                    provider,
                    sourceHome: "/fixture/source",
                    text: "Synthetic answer\\nwith media references",
                },
                {
                    nativeWorkers: () => [
                        {
                            provider,
                            name: "fixture",
                            sessionId: "fixture-session",
                            sourceHome: "/fixture/source",
                            turns: 1,
                            ready: true,
                        },
                    ],
                    findTargets: async () => {
                        throw new Error("native route must not require cmux");
                    },
                    runTool: async (args) => {
                        calls.push(args);
                        promptFile = args[args.indexOf("--prompt-file") + 1];
                        expect(readFileSync(promptFile, "utf8")).toBe("Synthetic answer\\nwith media references");
                        return {
                            success: true,
                            stderr: "",
                            stdout: SafeJSON.stringify({
                                kind: "turn",
                                backend: provider,
                                name: "fixture",
                                sessionId: "fixture-session",
                                sourceHome: "/fixture/source",
                                turn: 2,
                                completed: true,
                                exitCode: 0,
                            }),
                        };
                    },
                }
            );
            expect(result).toEqual({
                channel: "resume",
                delivered: true,
                target: `${provider} worker fixture · resumed turn 2`,
            });
            expect(calls[0].slice(0, provider === "claude" ? 3 : 2)).toEqual(
                provider === "claude" ? ["claude", "worker", "steer"] : ["grok", "steer"]
            );
            expect(calls[0]).toContain("--expect-session");
            expect(calls[0]).not.toContain("Synthetic answer\\nwith media references");
            expect(existsSync(promptFile)).toBe(false);
        }
    });

    test("native route rejects wrong provider, source home, worker-name aliases, busy and unstarted sessions", async () => {
        const worker = {
            provider: "grok" as const,
            name: "fixture",
            sessionId: "fixture-session",
            sourceHome: "/fixture/source",
            turns: 1,
            ready: true,
        };
        const lookup = { nativeWorkers: () => [worker], findTargets: noPaneTargets };
        for (const target of [
            { provider: "claude", session: "fixture-session", sourceHome: "/fixture/source" },
            { provider: "grok", session: "fixture-session", sourceHome: "/different/home" },
            { provider: "grok", session: "fixture", sourceHome: "/fixture/source" },
        ]) {
            expect((await resolveDeliveryTarget(target, lookup)).kind).toBe("none");
        }
        for (const reason of ["worker is busy", "session has not started"]) {
            const target = await resolveDeliveryTarget(
                { provider: "grok", session: "fixture-session", sourceHome: "/fixture/source" },
                {
                    nativeWorkers: () => [{ ...worker, ready: false, reason }],
                    findTargets: async () => {
                        throw new Error("must not reroute an owned unavailable worker");
                    },
                }
            );
            expect(target).toEqual({ kind: "none", reason });
        }
    });

    test("native delivery never accepts a lost, incomplete, wrong-session or wrong-turn receipt", async () => {
        const worker = {
            provider: "grok" as const,
            name: "fixture",
            sessionId: "fixture-session",
            sourceHome: "/fixture/source",
            turns: 1,
            ready: true,
        };
        const receipt = {
            kind: "turn",
            backend: "grok",
            name: "fixture",
            sessionId: "fixture-session",
            sourceHome: "/fixture/source",
            turn: 2,
            completed: true,
            exitCode: 0,
        };
        for (const body of [
            "not json",
            "{}",
            ...[
                { backend: "claude" },
                { sessionId: "new-copy" },
                { sourceHome: "/wrong/home" },
                { turn: 3 },
                { completed: false },
                { exitCode: 1 },
            ].map((change) => SafeJSON.stringify({ ...receipt, ...change })),
        ]) {
            let calls = 0;
            await expect(
                deliverToSession(
                    {
                        provider: "grok",
                        session: worker.sessionId,
                        sourceHome: worker.sourceHome,
                        text: "Synthetic reply",
                    },
                    {
                        nativeWorkers: () => [worker],
                        runTool: async () => {
                            calls += 1;
                            return { success: true, stdout: body, stderr: "" };
                        },
                        findTargets: async () => {
                            throw new Error("An attempted native send must not fall back and duplicate");
                        },
                    }
                )
            ).rejects.toBeInstanceOf(DeliveryUnknownError);
            expect(calls).toBe(1);
        }
        const rejected = await deliverToSession(
            { provider: "grok", session: worker.sessionId, sourceHome: worker.sourceHome, text: "Synthetic reply" },
            {
                nativeWorkers: () => [worker],
                runTool: async () => ({
                    success: false,
                    stderr: "",
                    stdout: SafeJSON.stringify({
                        kind: "rejected",
                        backend: "grok",
                        name: "fixture",
                        error: "Worker became busy before receiving input",
                    }),
                }),
            }
        );
        expect(rejected).toEqual({
            channel: "queued",
            delivered: false,
            error: "Worker became busy before receiving input",
        });
    });

    test("a Claude or Grok session gets one line typed into its cmux pane", async () => {
        const { calls, runTool } = spy({ success: true, stdout: '{"sent":true}' });
        const result = await deliverToSession(
            { session: "abc", provider: "claude-code", text: "DECISION 1: a) yes\nDECISION 2: b) no" },
            { runTool, findTargets: livePaneTargets }
        );

        expect(result).toMatchObject({ channel: "cmux", delivered: true, target: "cmux · work · agent" });
        expect(calls).toEqual([
            [
                "claude",
                "cmux",
                "send",
                "--json",
                "--paste",
                "--exact-session",
                "--harness",
                "claude",
                "--",
                "abc",
                "DECISION 1: a) yes\nDECISION 2: b) no",
            ],
        ]);
    });

    /** A leader on one socket that lists `listed` and acknowledges a prompt as `ack` does. */
    function fakeLeader(listed: string[], ack: "queued" | "silent" | "refused" = "queued") {
        const prompts: { socket: string; sessionId: string; text: string }[] = [];
        let closed = 0;
        const client = (socket: string): GrokLeaderClient => ({
            listSessions: async () => listed.map((sessionId) => ({ sessionId, cwd: "/fixture/repo" })),
            promptSession: async (sessionId, text) => {
                prompts.push({ socket, sessionId, text });
                if (ack === "silent") {
                    throw new Error("no queue acknowledgement within 30000 ms; it may have been accepted");
                }

                if (ack === "refused") {
                    throw new GrokAcpRefusedError("Path not found (FS_NOT_FOUND)");
                }

                return { outcome: "queued", promptId: "p-1" };
            },
            reset: () => {
                closed += 1;
            },
        });
        return { client, prompts, closed: () => closed };
    }

    const GROK_SESSION = "11111111-1111-4111-8111-111111111111";

    test("a Grok session in a leader gets the answer as a prompt there, with no keystrokes", async () => {
        const leader = fakeLeader([GROK_SESSION]);
        const never = async (): Promise<never> => {
            throw new Error("must not type when the leader took the answer");
        };
        const result = await deliverToSession(
            { session: GROK_SESSION, provider: "grok", text: "DECISION 4: b) keep it" },
            {
                runTool: never,
                nativeWorkers: () => [],
                findTargets: livePaneTargets,
                grokLeaderSockets: () => ["/state/leaders/shop.sock"],
                grokLeaderClient: leader.client,
            }
        );

        expect(result).toEqual({
            channel: "grok-leader",
            delivered: true,
            target: `Grok leader · session ${GROK_SESSION} · prompt p-1`,
        });
        expect(leader.prompts).toEqual([
            { socket: "/state/leaders/shop.sock", sessionId: GROK_SESSION, text: "DECISION 4: b) keep it" },
        ]);
        expect(leader.closed()).toBe(1);
    });

    test.each([
        ["no leader socket exists", [] as string[], [GROK_SESSION]],
        [
            "the leader holds other sessions only",
            ["/state/leaders/shop.sock"],
            ["22222222-2222-4222-8222-222222222222"],
        ],
    ])("when %s, the Grok answer is typed into its pane (guarded) instead", async (_label, sockets, listed) => {
        const leader = fakeLeader(listed);
        const { calls, runTool } = spy({ success: true, stdout: '{"sent":true}' });
        const result = await deliverToSession(
            { session: GROK_SESSION, provider: "grok", text: "DECISION 5: a) yes" },
            {
                runTool,
                nativeWorkers: () => [],
                findTargets: livePaneTargets,
                openDialog: () => null,
                grokLeaderSockets: () => sockets,
                grokLeaderClient: leader.client,
            }
        );

        expect(result).toMatchObject({ channel: "cmux", delivered: true, target: "cmux · work · agent" });
        expect(leader.prompts).toEqual([]);
        expect(calls).toEqual([
            [
                "claude",
                "cmux",
                "send",
                "--json",
                "--paste",
                "--exact-session",
                "--harness",
                "grok",
                "--",
                GROK_SESSION,
                "DECISION 5: a) yes",
            ],
        ]);
    });

    test("a leader refusal falls back to the pane, and a missing acknowledgement is unknown and types nothing", async () => {
        const refused = fakeLeader([GROK_SESSION], "refused");
        const { calls, runTool } = spy({ success: true, stdout: '{"sent":true}' });
        const deps = {
            nativeWorkers: () => [],
            findTargets: livePaneTargets,
            openDialog: () => null,
            grokLeaderSockets: () => ["/state/leaders/shop.sock"],
        };
        const request = { session: GROK_SESSION, provider: "grok", text: "DECISION 6: c) later" };

        expect(await deliverToSession(request, { ...deps, runTool, grokLeaderClient: refused.client })).toMatchObject({
            channel: "cmux",
            delivered: true,
        });
        expect(calls).toHaveLength(1);

        const silent = fakeLeader([GROK_SESSION], "silent");
        const never = async (): Promise<never> => {
            throw new Error("must not type after an unacknowledged leader prompt");
        };
        await expect(
            deliverToSession(request, { ...deps, runTool: never, grokLeaderClient: silent.client })
        ).rejects.toBeInstanceOf(DeliveryUnknownError);
        expect(silent.prompts).toHaveLength(1);
    });

    test("a leader session matches by id, else by the one session in the folder", () => {
        const sessions = [
            { sessionId: "a", cwd: "/fixture/one" },
            { sessionId: "b", cwd: "/fixture/two" },
            { sessionId: "c", cwd: "/fixture/two" },
        ];
        expect(matchLeaderSession(sessions, { sessionId: "b", cwd: "/fixture/one" })?.sessionId).toBe("b");
        expect(matchLeaderSession(sessions, { sessionId: "zzz", cwd: "/fixture/one" })?.sessionId).toBe("a");
        expect(matchLeaderSession(sessions, { sessionId: "zzz", cwd: "/fixture/two" })).toBeUndefined();
        expect(matchLeaderSession(sessions, { sessionId: "zzz" })).toBeUndefined();
    });

    test("an open dialog stops the typed rung before any keystroke; the answer is queued with the reason", async () => {
        const queueRoot = mkdtempSync(join(tmpdir(), "dialog-guard-queue-"));
        const asked: unknown[] = [];
        const never = async (): Promise<never> => {
            throw new Error("must not type while a dialog is open");
        };
        const request = {
            session: "dialog-session",
            provider: "claude",
            sourceHome: "/fixture/home",
            deliveryKey: "dialog-key",
            text: "DECISION 3: b) no",
        };
        const result = await deliverToSession(request, {
            runTool: never,
            nativeWorkers: () => [],
            claudePeers: () => [],
            findTargets: livePaneTargets,
            queueRoot,
            openDialog: (input) => {
                asked.push(input);
                return { kind: "decision", question: "Ship it?", signal: "turn-state" };
            },
        });

        expect(result).toMatchObject({ channel: "queued", delivered: false, queueId: expect.any(String) });
        expect(result.error).toStartWith("a question dialog is open in the session (Ship it?)");
        expect(asked).toEqual([{ provider: "claude", sessionId: "dialog-session", sourceHome: "/fixture/home" }]);
        expect(
            listSessionMessages({
                target: { provider: "claude", sessionId: "dialog-session", sourceHome: "/fixture/home" },
                root: queueRoot,
            }).map((message) => message.text)
        ).toEqual(["DECISION 3: b) no"]);

        // force types anyway and never asks the guard.
        const { calls, runTool } = spy({ success: true, stdout: '{"sent":true}' });
        const forced = await deliverToSession(
            { session: "dialog-session", provider: "claude", text: "DECISION 3: b) no", force: true },
            {
                runTool,
                nativeWorkers: () => [],
                claudePeers: () => [],
                findTargets: livePaneTargets,
                openDialog: () => {
                    throw new Error("force must not ask the dialog guard");
                },
            }
        );
        expect(forced).toMatchObject({ channel: "cmux", delivered: true });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.slice(0, 3)).toEqual(["claude", "cmux", "send"]);
        expect(calls[0]).toContain("--force");

        // A dialog that opened after this check is still caught by the send's own guard; its sentence comes back.
        const reason = "a plan approval is open in the session (Approve the plan?); free text would land there.";
        const late = spy({
            success: false,
            stdout: SafeJSON.stringify({ sent: false, reason, dialog: { kind: "plan" } }),
        });
        const refused = await deliverToSession(
            { session: "dialog-session", provider: "claude", text: "DECISION 3: b) no" },
            {
                runTool: late.runTool,
                nativeWorkers: () => [],
                claudePeers: () => [],
                findTargets: livePaneTargets,
                openDialog: () => null,
            }
        );
        expect(refused).toMatchObject({ channel: "queued", delivered: false, error: reason });
        expect(late.calls[0]).not.toContain("--force");
    });

    test("the structural Claude peer rung is never guarded: a dialog cannot swallow a socket message", async () => {
        const peer = {
            pid: 42,
            sessionId: "peer-session",
            name: "fixture",
            cwd: "/fixture/project",
            status: "waiting",
            kind: "interactive",
            socketPath: "/fixture/receiver.sock",
            file: "/fixture/home/sessions/42.json",
        };
        let socketWrites = 0;
        const result = await deliverToSession(
            { session: peer.sessionId, provider: "claude", text: "DECISION 1: a) yes" },
            {
                nativeWorkers: () => [],
                claudePeers: () => [peer],
                peerToken: () => null,
                receiverMode: async () => "prompting",
                sendClaudePeer: async () => {
                    socketWrites++;
                },
                openDialog: () => {
                    throw new Error("the peer rung must not ask the dialog guard");
                },
                runTool: async () => {
                    throw new Error("the peer rung must not type");
                },
            }
        );

        expect(result).toMatchObject({ channel: "claude-peer", delivered: true });
        expect(socketWrites).toBe(1);
    });

    test("the ladder takes the peer socket over a live pane, and the pane only when no peer claims the session", async () => {
        const peer = {
            pid: 42,
            sessionId: "ladder-session",
            name: "fixture",
            cwd: "/fixture/project",
            status: "idle",
            kind: "interactive",
            socketPath: "/fixture/receiver.sock",
            file: "/fixture/home/sessions/42.json",
        };
        const rungs: string[] = [];
        const deps = {
            nativeWorkers: () => [],
            peerToken: () => null,
            receiverMode: async () => "prompting" as const,
            sendClaudePeer: async () => {
                rungs.push("socket");
            },
            findTargets: (session: string) => {
                rungs.push("pane lookup");
                return livePaneTargets(session);
            },
            openDialog: () => null,
            runTool: async () => {
                rungs.push("typed");
                return { success: true, stdout: '{"sent":true}', stderr: "" };
            },
        };
        const request = { session: peer.sessionId, provider: "claude", text: "DECISION 1: a) yes" };

        expect(await deliverToSession(request, { ...deps, claudePeers: () => [peer] })).toMatchObject({
            channel: "claude-peer",
            delivered: true,
        });
        expect(rungs).toEqual(["socket"]);

        rungs.length = 0;
        expect(await deliverToSession(request, { ...deps, claudePeers: () => [] })).toMatchObject({
            channel: "cmux",
            delivered: true,
        });
        expect(rungs).toEqual(["pane lookup", "typed"]);
    });

    test("a closed pane is found BEFORE anything is typed: nothing runs, the reason is one sentence", async () => {
        const never = async (): Promise<never> => {
            throw new Error("must not type when no pane is live");
        };
        const result = await deliverToSession(
            { session: "abc", provider: "claude", text: "DECISION 1: a) yes" },
            { runTool: never, findTargets: noPaneTargets }
        );

        expect(result).toEqual({ channel: "queued", delivered: false, error: "no cmux pane runs this session" });
    });

    test("an unmatched pane leaves the answers queued", async () => {
        const { runTool } = spy({ success: false, stdout: '{"sent":false,"matches":[]}' });
        const result = await deliverToSession(
            { session: "abc", provider: "grok", text: "DECISION 1: yes" },
            { runTool, findTargets: livePaneTargets }
        );

        expect(result.channel).toBe("queued");
        expect(result.delivered).toBe(false);
    });

    test("an original Claude receiver takes one literal media message without terminal lookup", async () => {
        const peer = {
            pid: 42,
            sessionId: "original-session",
            name: "fixture",
            cwd: "/fixture/project",
            status: "busy",
            kind: "interactive",
            socketPath: "/fixture/receiver.sock",
            file: "/fixture/home/sessions/42.json",
        };
        const received: unknown[] = [];
        const text = '<fromImage>\n{"path":"/fixture/c96d5e67-image.png"}\n</fromImage>';
        const result = await deliverToSession(
            { session: peer.sessionId, provider: "claude", sourceHome: "/fixture/home", text },
            {
                nativeWorkers: () => [],
                claudePeers: (home) => {
                    expect(home).toBe("/fixture/home");
                    return [peer];
                },
                peerToken: (_session, directory) => {
                    expect(directory).toBe("/fixture/home/sessions");
                    return null;
                },
                sendClaudePeer: async (input) => {
                    received.push(input);
                },
                receiverMode: async () => "prompting",
                findTargets: async () => {
                    throw new Error("Native delivery must not inspect terminals");
                },
                runTool: async () => {
                    throw new Error("Native delivery must not type a fallback");
                },
            }
        );
        expect(result).toEqual({ channel: "claude-peer", delivered: true, target: "original Claude session" });
        expect(received).toEqual([
            { session: peer, text, token: null, priority: "next", sender: null, timeoutMs: 5000 },
        ]);
    });

    // DECISION 25 a): a bypass receiver holds a plain frame for approval, so the answer carries a stand-in sender
    // of the receiver's class; a receiver of unknown class gets the plain frame as before.
    test("a bypass Claude receiver gets the answer from a stand-in bypass sender", async () => {
        const peer = {
            pid: 43,
            sessionId: "bypass-session",
            name: "fixture",
            cwd: "/fixture/project",
            status: "idle",
            kind: "interactive",
            socketPath: "/fixture/receiver.sock",
            file: "/fixture/home/sessions/43.json",
        };
        for (const [mode, attested] of [
            ["bypass", true],
            [null, false],
        ] as const) {
            const senders: unknown[] = [];
            await deliverToSession(
                { session: peer.sessionId, provider: "claude", sourceHome: "/fixture/home", text: "a)" },
                {
                    nativeWorkers: () => [],
                    claudePeers: () => [peer],
                    peerToken: () => null,
                    receiverMode: async (sessionId) => {
                        expect(sessionId).toBe(peer.sessionId);
                        return mode;
                    },
                    sendClaudePeer: async (input) => {
                        senders.push(input.sender);
                    },
                }
            );
            expect(senders).toEqual([attested ? standInSender("bypass") : null]);
        }
    });

    test("real native peer transport preserves a long Unicode reply as one user frame", async () => {
        const home = mkdtempSync(join(tmpdir(), "p-"));
        const socketPath = join(home, "p.sock");
        const frames: unknown[] = [];
        let accept!: (value: unknown) => void;
        const received = new Promise<unknown>((resolve) => {
            accept = resolve;
        });
        let buffered = "";
        const decoder = new TextDecoder();
        const server = Bun.listen({
            unix: socketPath,
            socket: {
                data(socket, bytes) {
                    buffered += decoder.decode(bytes, { stream: true });
                    const newline = buffered.indexOf("\n");
                    if (newline >= 0) {
                        const frame: unknown = SafeJSON.parse(buffered.slice(0, newline), { strict: true });
                        frames.push(frame);
                        accept(frame);
                        socket.end();
                    }
                },
            },
        });
        const peer = {
            pid: 42,
            sessionId: "fixture-original-session",
            name: null,
            cwd: null,
            status: "busy",
            kind: null,
            socketPath,
            file: join(home, "sessions/42.json"),
        };
        const text =
            "<fromVideo>\n" + "Literal line ž 漢字 /fixture/c96d5e67-image.png\n".repeat(1200) + "</fromVideo>";
        try {
            const result = await deliverToSession(
                { session: peer.sessionId, provider: "claude", sourceHome: home, text },
                {
                    nativeWorkers: () => [],
                    claudePeers: () => [peer],
                    peerToken: () => null,
                    findTargets: async () => {
                        throw new Error("A native socket must not use terminal delivery");
                    },
                }
            );
            expect(result).toMatchObject({ channel: "claude-peer", delivered: true });
            expect(await withTimeout(received, 5000)).toMatchObject({
                type: "user",
                session_id: peer.sessionId,
                message: { role: "user", content: text },
                priority: "next",
            });
            expect(frames).toHaveLength(1);
        } finally {
            server.stop(true);
        }
    });

    test("a failed native Claude write never retries through a terminal or a durable queue", async () => {
        const peer = {
            pid: 42,
            sessionId: "original-session",
            name: null,
            cwd: null,
            status: "busy",
            kind: null,
            socketPath: "/fixture/receiver.sock",
            file: "/fixture/home/sessions/42.json",
        };
        const queueRoot = mkdtempSync(join(tmpdir(), "peer-unknown-"));
        await expect(
            deliverToSession(
                {
                    session: peer.sessionId,
                    provider: "claude",
                    sourceHome: "/fixture/home",
                    text: "literal reply",
                    deliveryKey: "once",
                },
                {
                    queueRoot,
                    nativeWorkers: () => [],
                    claudePeers: () => [peer],
                    peerToken: () => null,
                    sendClaudePeer: async () => {
                        throw new Error("Disconnected after writing");
                    },
                    findTargets: async () => {
                        throw new Error("No terminal fallback after an uncertain write");
                    },
                }
            )
        ).rejects.toBeInstanceOf(DeliveryUnknownError);
        expect(
            listSessionMessages({
                root: queueRoot,
                target: { provider: "claude", sessionId: peer.sessionId, sourceHome: "/fixture/home" },
            })
        ).toEqual([]);
    });

    test("a native Claude receiver swap is refused at the consuming boundary", async () => {
        const peer = {
            pid: 42,
            sessionId: "original-session",
            name: null,
            cwd: null,
            status: "busy",
            kind: null,
            socketPath: "/fixture/receiver.sock",
            file: "/fixture/home/sessions/42.json",
        };
        let reads = 0;
        const result = await deliverToSession(
            { session: peer.sessionId, provider: "claude", sourceHome: "/fixture/home", text: "media reply" },
            {
                nativeWorkers: () => [],
                claudePeers: () =>
                    ++reads === 1 ? [peer] : [{ ...peer, pid: 43, socketPath: "/fixture/replacement.sock" }],
                sendClaudePeer: async () => {
                    throw new Error("The replacement must never receive a message");
                },
            }
        );
        expect(result).toMatchObject({
            delivered: false,
            error: "The native Claude receiver changed before delivery; no message was written.",
        });
        expect(reads).toBe(2);
    });

    test("native Claude routing rejects another home or duplicate receivers before any transport", async () => {
        const peer = {
            pid: 42,
            sessionId: "original-session",
            name: null,
            cwd: null,
            status: "busy",
            kind: null,
            socketPath: "/fixture/receiver.sock",
            file: "/fixture/other-home/sessions/42.json",
        };
        const request = { session: peer.sessionId, provider: "claude", sourceHome: "/fixture/home" };
        expect(
            await resolveDeliveryTarget(request, { nativeWorkers: () => [], claudePeers: () => [peer] })
        ).toMatchObject({ kind: "none", reason: "The native Claude receiver belongs to another source home." });
        expect(
            await resolveDeliveryTarget(request, { nativeWorkers: () => [], claudePeers: () => [peer, peer] })
        ).toMatchObject({
            kind: "none",
            reason: expect.stringMatching(/^2 Claude terminals run this session \(pid 42, pid 42\).*none was picked/),
        });
    });

    test("a session resumed in two terminals goes to the one active last, unless both moved recently", async () => {
        const base = {
            sessionId: "original-session",
            name: null,
            cwd: null,
            status: "idle",
            kind: null,
        };
        const stale = { ...base, pid: 41, socketPath: "/fixture/41.sock", file: "/fixture/home/sessions/41.json" };
        const active = { ...base, pid: 42, socketPath: "/fixture/42.sock", file: "/fixture/home/sessions/42.json" };
        const request = { session: "original-session", provider: "claude", sourceHome: "/fixture/home" };
        const now = 1_800_000_000_000;
        const picked = await resolveDeliveryTarget(request, {
            nativeWorkers: () => [],
            claudePeers: () => [
                { ...stale, updatedAt: now - 17 * 3600_000 },
                { ...active, updatedAt: now - 2 * 60_000 },
            ],
        });
        expect(picked).toMatchObject({ kind: "claude-peer", peer: { pid: 42 } });
        expect(picked.kind === "claude-peer" ? picked.label : "").toContain("1 older copy idle");

        expect(
            await resolveDeliveryTarget(request, {
                nativeWorkers: () => [],
                claudePeers: () => [
                    { ...stale, updatedAt: now - 3 * 60_000 },
                    { ...active, updatedAt: now - 60_000 },
                ],
            })
        ).toMatchObject({ kind: "none", reason: expect.stringContaining("pid 42, pid 41") });
    });

    test("a parked registry entry blocks even a live recorded terminal, while absent entries allow fallback", async () => {
        const home = mkdtempSync(join(tmpdir(), "parked-routing-"));
        const registry = {
            pid: 42,
            sessionId: "parked-session",
            messagingSocketPath: "/fixture/42.sock",
            parkedJobId: "background-job",
        };
        writeFileSync(join(home, "42.json"), SafeJSON.stringify(registry));
        const peers = () => listClaudeSessionInventory({ dir: home, liveOf: (pids) => new Set(pids) });
        const recorded = await livePaneTargets(registry.sessionId);
        recorded.source = "recorded";
        recorded.targets = recorded.targets.map((target) => ({ ...target, matchedOn: "recorded" }));
        recorded.snapshot = {
            fetchedAt: "2026-01-01T00:00:00Z",
            available: true,
            workspaces: [{ id: "ws-1", name: "work" }],
            panes: [
                {
                    id: "pane:1",
                    workspaceId: "ws-1",
                    title: "agent",
                    active: true,
                    surfaceCount: 1,
                    surfaces: [
                        {
                            id: "surface:1",
                            title: "agent",
                            type: "terminal",
                            index: 0,
                            selected: true,
                            active: true,
                        },
                    ],
                },
            ],
        };
        let socketWrites = 0;
        let terminalWrites = 0;
        let lookups = 0;
        const deps = {
            nativeWorkers: () => [],
            claudePeers: peers,
            peerToken: () => null,
            sendClaudePeer: async () => {
                socketWrites++;
            },
            findTargets: async () => {
                lookups++;
                return recorded;
            },
            runTool: async () => {
                terminalWrites++;
                return { success: true, stdout: '{"sent":true}', stderr: "" };
            },
        };
        const request = { session: registry.sessionId, provider: "claude", text: "decision answer" };
        expect(await deliverToSession(request, deps)).toMatchObject({
            channel: "queued",
            delivered: false,
            error: expect.stringContaining("parked in a background job"),
        });
        expect([socketWrites, terminalWrites, lookups]).toEqual([0, 0, 0]);

        // Control: the same recorded target remains a working fallback when no registry entry claims the session.
        expect(await deliverToSession(request, { ...deps, claudePeers: () => [] })).toMatchObject({
            channel: "cmux",
            delivered: true,
        });
        expect([socketWrites, terminalWrites, lookups]).toEqual([0, 1, 1]);

        // A live, unparked copy of the same session is still a valid receiver.
        writeFileSync(
            join(home, "43.json"),
            SafeJSON.stringify({
                ...registry,
                pid: 43,
                messagingSocketPath: "/fixture/43.sock",
                parkedJobId: undefined,
            })
        );
        expect(await deliverToSession(request, deps)).toMatchObject({ channel: "claude-peer", delivered: true });
        expect([socketWrites, terminalWrites, lookups]).toEqual([1, 1, 1]);
    });

    test("a Claude receiver that parks before the consuming write is refused", async () => {
        const home = mkdtempSync(join(tmpdir(), "parking-race-"));
        const file = join(home, "42.json");
        const registry = { pid: 42, sessionId: "parking-session", messagingSocketPath: "/fixture/42.sock" };
        writeFileSync(file, SafeJSON.stringify(registry));
        let reads = 0;
        let writes = 0;
        const result = await deliverToSession(
            { session: registry.sessionId, provider: "claude", text: "answer" },
            {
                nativeWorkers: () => [],
                claudePeers: () => {
                    const peers = listClaudeSessionInventory({ dir: home, liveOf: (pids) => new Set(pids) });
                    if (++reads === 1) {
                        writeFileSync(file, SafeJSON.stringify({ ...registry, parkedJobId: "background-job" }));
                    }

                    return peers;
                },
                peerToken: () => null,
                sendClaudePeer: async () => {
                    writes++;
                },
                runTool: async () => {
                    writes++;
                    return { success: true, stdout: '{"sent":true}', stderr: "" };
                },
            }
        );
        expect(result).toMatchObject({ delivered: false, error: expect.stringContaining("receiver changed") });
        expect(reads).toBe(2);
        expect(writes).toBe(0);
    });

    test("duplicate Claude receivers need a valid activity timestamp on every copy", async () => {
        const peer = {
            sessionId: "original-session",
            name: null,
            cwd: null,
            status: "idle",
            kind: null,
            pid: 42,
            socketPath: "/fixture/42.sock",
            file: "/fixture/home/sessions/42.json",
            updatedAt: 1_800_000_000_000,
        };
        const request = { session: peer.sessionId, provider: "claude", sourceHome: "/fixture/home", text: "reply" };
        for (const updatedAt of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            const unknown = { ...peer, pid: 43, socketPath: "/fixture/43.sock", updatedAt };
            for (const peers of [
                [peer, unknown],
                [unknown, peer],
                [peer, { ...peer, pid: 44, updatedAt: 1 }, unknown],
            ]) {
                let sends = 0;
                const result = await deliverToSession(request, {
                    nativeWorkers: () => [],
                    claudePeers: () => peers,
                    peerToken: () => null,
                    sendClaudePeer: async () => {
                        sends++;
                    },
                });
                expect(result).toMatchObject({ delivered: false, error: expect.stringContaining("none was picked") });
                expect(sends).toBe(0);
            }
        }

        let reads = 0;
        const changed = await deliverToSession(request, {
            nativeWorkers: () => [],
            claudePeers: () => [peer, { ...peer, pid: 43, updatedAt: ++reads === 1 ? 1 : undefined }],
            sendClaudePeer: async () => {
                throw new Error("Unknown recency at the consuming boundary must prevent a write");
            },
        });
        expect(changed).toMatchObject({ delivered: false, error: expect.stringContaining("receiver changed") });
        expect(reads).toBe(2);
    });

    test("automatic replies never type into a lone cwd or screen-text match", async () => {
        for (const source of ["cwd", "screen"] as const) {
            let sends = 0;
            const result = await deliverToSession(
                { session: "original-session", provider: "claude", text: "media reply" },
                {
                    findTargets: async (session) => ({ ...(await livePaneTargets(session)), source }),
                    runTool: async () => {
                        sends++;
                        return { success: true, stdout: '{"sent":true}', stderr: "" };
                    },
                }
            );
            expect(result).toMatchObject({
                delivered: false,
                error: "the cmux match does not identify the exact recipient session",
            });
            expect(sends).toBe(0);
        }
    });

    test("automatic replies judge the evidence, not the stage: a printed id or a topic title is refused", async () => {
        for (const matchedOn of ["session-id", "id-prefix", "session-name", "pane-title"] as const) {
            let sends = 0;
            const result = await deliverToSession(
                { session: "original-session", provider: "claude", text: "media reply" },
                {
                    findTargets: async (session) => {
                        const live = await livePaneTargets(session);
                        return { ...live, targets: live.targets.map((target) => ({ ...target, matchedOn })) };
                    },
                    runTool: async () => {
                        sends++;
                        return { success: true, stdout: '{"sent":true}', stderr: "" };
                    },
                }
            );
            expect(result).toMatchObject({
                delivered: false,
                error: "the cmux match does not identify the exact recipient session",
            });
            expect(sends).toBe(0);
        }

        // Control: the same lone pane proven by the id `restore` stamps into its tab title still receives the reply.
        let sends = 0;
        const proven = await deliverToSession(
            { session: "original-session", provider: "claude", text: "media reply" },
            {
                findTargets: livePaneTargets,
                runTool: async () => {
                    sends++;
                    return { success: true, stdout: '{"sent":true}', stderr: "" };
                },
            }
        );
        expect(proven).toMatchObject({ channel: "cmux", delivered: true });
        expect(sends).toBe(1);
    });

    test("a readable cmux refusal reaches the durable session queue, while unreadable output does not", async () => {
        const queueRoot = mkdtempSync(join(tmpdir(), "cmux-refusal-queue-"));
        const request = {
            session: "abc",
            provider: "claude",
            text: "DECISION 1: a) yes",
            sourceHome: "/fixture/claude",
            deliveryKey: "fixture-key",
        };
        const refused = await deliverToSession(request, {
            runTool: spy({ success: false, stdout: '{"sent":false,"matches":[]}' }).runTool,
            findTargets: livePaneTargets,
            queueRoot,
        });
        expect(refused).toMatchObject({ channel: "queued", delivered: false });
        expect(refused.queueId).toBeDefined();
        const unknown = await deliverToSession(
            { ...request, deliveryKey: "other-key" },
            { runTool: spy({ success: false, stdout: "not json" }).runTool, findTargets: livePaneTargets, queueRoot }
        );
        expect(unknown).toMatchObject({ channel: "queued", delivered: false });
        expect(unknown.queueId).toBeUndefined();
    });

    test("a message over the queue limit is reported as not saved and not sent, yet a live pane still takes it", async () => {
        const queueRoot = mkdtempSync(join(tmpdir(), "oversized-queue-"));
        const request = {
            session: "abc",
            provider: "claude",
            text: "あ".repeat(24_000),
            sourceHome: "/fixture/claude",
            deliveryKey: "oversized-key",
        };
        const unsaved = await deliverToSession(request, { findTargets: noPaneTargets, queueRoot });

        expect(unsaved).toMatchObject({
            channel: "queued",
            delivered: false,
            error: expect.stringContaining("too large to save"),
        });
        expect(unsaved.queueId).toBeUndefined();
        expect(
            listSessionMessages({
                target: { provider: "claude", sessionId: "abc", sourceHome: "/fixture/claude" },
                root: queueRoot,
            })
        ).toEqual([]);

        const live = await deliverToSession(request, {
            findTargets: livePaneTargets,
            runTool: spy({ success: true, stdout: '{"sent":true}' }).runTool,
            queueRoot,
        });
        expect(live).toMatchObject({ channel: "cmux", delivered: true });
    });

    test("a retry of a key an earlier attempt already saved stays in the queue, even when a live pane appears", async () => {
        const queueRoot = mkdtempSync(join(tmpdir(), "keyed-retry-queue-"));
        const request = {
            session: "abc",
            provider: "claude",
            text: "DECISION 1: a) yes",
            sourceHome: "/fixture/claude",
            deliveryKey: "fixture-key",
        };
        const first = await deliverToSession(request, { findTargets: noPaneTargets, queueRoot });
        expect(first.queueId).toBeDefined();
        const never = async (): Promise<never> => {
            throw new Error("must not type a message that is already queued");
        };
        const retry = await deliverToSession(request, { runTool: never, findTargets: livePaneTargets, queueRoot });

        expect(retry).toMatchObject({ channel: "queued", delivered: false, queueId: first.queueId });
        expect(
            listSessionMessages({
                target: { provider: "claude", sessionId: "abc", sourceHome: "/fixture/claude" },
                root: queueRoot,
            })
        ).toHaveLength(1);
    });

    test("Codex daemon queue acceptance and empty exit-zero output are not provider input receipts", async () => {
        for (const stdout of ["{}", '{"queued":true}', '{"queued":false}', ""]) {
            await expect(
                deliverToSession(
                    { session: "fixture-thread", provider: "codex", text: "Synthetic" },
                    {
                        codexWorkerFor: () => "fixture",
                        runTool: async () => ({ success: true, stdout, stderr: "" }),
                    }
                )
            ).rejects.toBeInstanceOf(DeliveryUnknownError);
        }
    });

    test("a Codex thread run by a tools codex worker is steered, and one without a worker is queued untouched", async () => {
        const steered = spy({ success: true, stdout: '{"queued":false,"turnId":"fixture-turn"}' });
        const text = ["DECISION 1: a) yes\nDECISION 2: b) no", "Synthetic media reference ".repeat(10_000)].join("\n");

        expect(
            await deliverToSession(
                { session: "thread-1", provider: "codex", text },
                { runTool: steered.runTool, codexWorkerFor: () => "reviewer" }
            )
        ).toEqual({
            channel: "codex",
            delivered: true,
            target: "codex worker reviewer · input acknowledged (turn fixture-turn)",
        });
        expect(steered.calls).toEqual([
            ["codex", "steer", "--name", "reviewer", "--json", "--prompt-file", expect.any(String)],
        ]);
        expect(steered.prompts).toEqual([text]);
        expect(existsSync(steered.calls[0][6])).toBe(false);

        const never = async (): Promise<never> => {
            throw new Error("must not run a tool when no worker exists");
        };
        const queued = await deliverToSession(
            { session: "thread-2", provider: "codex", text },
            { runTool: never, codexWorkerFor: () => null }
        );
        expect(queued.channel).toBe("queued");
    });

    test("a Codex worker whose daemon is gone is no route and the answer is queued, while a live daemon is still the route", async () => {
        const home = mkdtempSync(join(tmpdir(), "codex-worker-liveness-"));
        const queueRoot = mkdtempSync(join(tmpdir(), "codex-worker-liveness-queue-"));
        const sourceHome = join(home, "codex-home");
        const gone = Bun.spawn(["true"], { env: process.env });
        await gone.exited;
        const alive = Bun.spawn(
            [process.execPath, "-e", "setTimeout(() => {}, 60000)", "--name", "live-worker", "codex-daemon"],
            { stdout: "ignore", stderr: "ignore", env: process.env }
        );
        const worker = (name: string, daemonPid: number, threadId: string): CodexSessionMeta => ({
            name,
            daemonPid,
            threadId,
            home: sourceHome,
            cwd: "/fixture/project",
            sandbox: "read-only",
            approvalPolicy: "never",
            writePolicy: "deny",
            status: "ready",
            agentName: name,
            rendezvousSession: "fixture-parent",
            agentsEnabled: false,
            startedAt: "2026-01-01T00:00:00.000Z",
            lastEventAt: "2026-01-01T00:00:00.000Z",
            codexVersion: "0.159.2",
            pendingApprovals: {},
        });

        try {
            await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
                const store = new CodexSessionStore();
                store.writeMeta(worker("stale-worker", gone.pid, "thread-stale"));
                store.writeMeta(worker("live-worker", alive.pid, "thread-live"));

                expect(
                    await resolveDeliveryTarget({ session: "thread-stale", provider: "codex", sourceHome })
                ).toMatchObject({ kind: "none" });
                expect(
                    await resolveDeliveryTarget({ session: "thread-live", provider: "codex", sourceHome })
                ).toMatchObject({ kind: "codex", worker: "live-worker" });

                const never = async (): Promise<never> => {
                    throw new Error("must not run a tool for a worker whose daemon is gone");
                };
                const queued = await deliverToSession(
                    {
                        session: "thread-stale",
                        provider: "codex",
                        sourceHome,
                        text: "DECISION 1: a) yes",
                        deliveryKey: "stale-key",
                    },
                    { runTool: never, queueRoot }
                );
                expect(queued).toMatchObject({ channel: "queued", delivered: false });
                expect(queued.queueId).toBeDefined();
            });
        } finally {
            alive.kill();
        }
    });
});

describe("a pane send that ran past its deadline", () => {
    // Before 2026-10-31 a timeout receipt (`sent: false, reason: "timeout"`) read as a refusal before input, so the
    // answer was saved to the session queue and could be delivered a second time after the first one was typed.
    test.each([
        ["the flagged receipt", { sent: false, unconfirmed: true, reason: "timeout", query: "abc", timeoutSeconds: 5 }],
        ["an older child's receipt", { sent: false, reason: "timeout", query: "abc", timeoutSeconds: 5 }],
    ])("%s is an unknown outcome and is never queued", async (_label, receipt) => {
        const queueRoot = mkdtempSync(join(tmpdir(), "pane-timeout-queue-"));
        const request = {
            session: "abc",
            provider: "claude",
            text: "DECISION 1: a) yes",
            sourceHome: "/fixture/claude",
            deliveryKey: "timeout-key",
        };

        await expect(
            deliverToSession(request, {
                runTool: async () => ({ success: false, stdout: SafeJSON.stringify(receipt), stderr: "" }),
                findTargets: livePaneTargets,
                openDialog: () => null,
                queueRoot,
            })
        ).rejects.toBeInstanceOf(DeliveryUnknownError);
        expect(
            listSessionMessages({
                root: queueRoot,
                target: { provider: "claude", sessionId: "abc", sourceHome: "/fixture/claude" },
            })
        ).toEqual([]);
    });

    const pane = (queueRoot: string, run: { success: boolean; stdout: string; timedOut?: boolean }) =>
        deliverToSession(
            {
                session: "abc",
                provider: "claude",
                text: "DECISION 1: a) yes",
                sourceHome: "/fixture/claude",
                deliveryKey: "killed-key",
            },
            {
                runTool: async () => ({ stderr: "", ...run }),
                findTargets: livePaneTargets,
                openDialog: () => null,
                queueRoot,
            }
        );
    const queued = (queueRoot: string) =>
        listSessionMessages({
            root: queueRoot,
            target: { provider: "claude", sessionId: "abc", sourceHome: "/fixture/claude" },
        });

    test("a child our runner killed at its deadline, with no receipt, is unknown and never queued", async () => {
        const queueRoot = mkdtempSync(join(tmpdir(), "pane-killed-queue-"));

        await expect(pane(queueRoot, { success: false, stdout: "", timedOut: true })).rejects.toBeInstanceOf(
            DeliveryUnknownError
        );
        expect(queued(queueRoot)).toEqual([]);
    });

    test("a child that exited with no output before any input is reported not delivered, and not queued", async () => {
        const queueRoot = mkdtempSync(join(tmpdir(), "pane-empty-queue-"));

        expect(await pane(queueRoot, { success: false, stdout: "" })).toMatchObject({
            channel: "queued",
            delivered: false,
            error: "the cmux send failed",
        });
        expect(queued(queueRoot)).toEqual([]);
    });

    test("a refusal the child printed before our deadline killed it still proves no input, so it is queued", async () => {
        const queueRoot = mkdtempSync(join(tmpdir(), "pane-killed-refusal-queue-"));
        const result = await pane(queueRoot, { success: false, stdout: '{"sent":false,"matches":[]}', timedOut: true });

        expect(result).toMatchObject({ channel: "queued", delivered: false });
        expect(result.queueId).toBeDefined();
    });

    test("a readable refusal before input is still queued (control)", async () => {
        const queueRoot = mkdtempSync(join(tmpdir(), "pane-refusal-queue-"));
        const result = await deliverToSession(
            {
                session: "abc",
                provider: "claude",
                text: "DECISION 1: a) yes",
                sourceHome: "/fixture/claude",
                deliveryKey: "refusal-key",
            },
            {
                runTool: async () => ({ success: false, stdout: '{"sent":false,"matches":[]}', stderr: "" }),
                findTargets: livePaneTargets,
                openDialog: () => null,
                queueRoot,
            }
        );
        expect(result).toMatchObject({ channel: "queued", delivered: false });
        expect(result.queueId).toBeDefined();
    });
});

describe("the live receiver edges in a test run", () => {
    test("without noNativeReceivers a delivery reads the sandboxed agent homes, never this Mac's real ones", async () => {
        const realHome = homedir();
        const claudeSessions = claudeSessionsDir();
        const grokSocket = defaultGrokLeaderSocket();

        // The preload points both homes at empty folders (isolateNativeHomes in preload-test-sandbox.ts).
        expect(claudeSessions.startsWith(join(realHome, ".claude"))).toBe(false);
        expect(grokSocket.startsWith(join(realHome, ".grok"))).toBe(false);

        // With nothing in the sandbox, the live edges find no receiver: the Claude session falls to the pane.
        expect(
            await resolveLive({ session: "sandbox-session", provider: "claude" }, { findTargets: noPaneTargets })
        ).toEqual({ kind: "none", reason: "no cmux pane runs this session" });

        // Positive control: a leader socket file in the sandboxed Grok home IS what the live edge reads.
        mkdirSync(dirname(grokSocket), { recursive: true });
        writeFileSync(grokSocket, "");
        try {
            expect(
                await resolveLive({ session: "sandbox-session", provider: "grok" }, { findTargets: noPaneTargets })
            ).toMatchObject({ kind: "grok-leader", sockets: [grokSocket] });
        } finally {
            unlinkSync(grokSocket);
        }
    });
});
