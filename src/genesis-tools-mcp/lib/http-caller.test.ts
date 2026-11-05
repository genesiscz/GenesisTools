import { afterAll, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whoIsCalling } from "@genesiscz/utils/agent/identity";
import { accountEnvVar } from "@genesiscz/utils/ai/account-env";
import { SafeJSON } from "@genesiscz/utils/json";
import type { ResolvedCaller } from "./http-caller";

// The caller lookup reads sockets, the process table and open files from the kernel. The modules that do are
// replaced by a table the tests fill in, and restored after the file, so nothing here touches a real process.
const realSocketOwner = await import("@genesiscz/utils/process/socket-owner");
const realProcessCwd = await import("@genesiscz/utils/process/cwd");

interface FakeProcess {
    pid: number;
    name: string;
    startSec: number;
    openFiles: string[];
    cwd: string | null;
}

let fakeProcesses: FakeProcess[] = [];
let loopbackOwners: number[] = [];

mock.module("@genesiscz/utils/process/socket-owner", () => ({
    ...realSocketOwner,
    findLoopbackClientPids: () => loopbackOwners,
    readProcessInfo: (pid: number) => {
        const found = fakeProcesses.find((row) => row.pid === pid);
        return found ? { pid, name: found.name, uid: 501, startSec: found.startSec } : null;
    },
    readOpenFilePaths: (pid: number) => fakeProcesses.find((row) => row.pid === pid)?.openFiles ?? [],
}));
mock.module("@genesiscz/utils/process/cwd", () => ({
    ...realProcessCwd,
    readProcessCwd: (pid: number) => fakeProcesses.find((row) => row.pid === pid)?.cwd ?? null,
}));

afterAll(() => {
    mock.module("@genesiscz/utils/process/socket-owner", () => realSocketOwner);
    mock.module("@genesiscz/utils/process/cwd", () => realProcessCwd);
});

const { callerSessionReadable, resolveCallerFromPeer } = await import("./http-caller");
const { codexThreadIdFromOpenFiles } = await import("@genesiscz/utils/agent-sessions/readers/codex-peer");

describe("codexThreadIdFromOpenFiles", () => {
    const rollout = (id: string) => `/Users/someone/.codex/sessions/2026/10/01/rollout-2026-10-01T03-02-36-${id}.jsonl`;
    const a = "01a0f4fc-171d-7c30-9679-ee00633dee2d";
    const b = "01a0f4fc-0000-7c30-9679-ee00633dee2d";

    it("names the thread when exactly one rollout is open", () => {
        expect(codexThreadIdFromOpenFiles(["/Users/someone/.codex/state_5.sqlite", rollout(a)])).toBe(a);
    });

    it("names nobody when several threads are open or none is", () => {
        expect(codexThreadIdFromOpenFiles([rollout(a), rollout(b)])).toBeNull();
        expect(codexThreadIdFromOpenFiles(["/Users/someone/.codex/state_5.sqlite"])).toBeNull();
        expect(codexThreadIdFromOpenFiles(["/tmp/rollout-x-" + a + ".jsonl"])).toBeNull();
    });
});

describe("characterization: who the gateway says the caller is", () => {
    const START_SEC = 1_800_000_000;
    const PEER = { clientPort: 50_001, serverPort: 50_002 };

    function sessionsDir(files: Record<string, unknown>): string {
        const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
        mkdirSync(dir, { recursive: true });

        for (const [name, body] of Object.entries(files)) {
            writeFileSync(join(dir, name), SafeJSON.stringify(body));
        }

        return dir;
    }

    function peer(process: Partial<FakeProcess> & { pid: number; name: string }): void {
        fakeProcesses = [{ startSec: START_SEC, openFiles: [], cwd: "/fixture/project", ...process }];
        loopbackOwners = [process.pid];
    }

    it("a Claude peer: the session comes from sessions/<pid>.json when its start time matches", () => {
        peer({ pid: 4101, name: "claude" });
        const dir = sessionsDir({
            "4101.json": { pid: 4101, sessionId: "claude-session-1", startedAt: (START_SEC + 30) * 1000 },
        });

        expect(resolveCallerFromPeer({ ...PEER, registryDirOf: () => dir })).toEqual({
            agent: "claude-code",
            sessionId: "claude-session-1",
            cwd: "/fixture/project",
            pid: 4101,
            processName: "claude",
        });
    });

    it("a Claude peer: the start time may differ by up to 120 seconds, and not more", () => {
        peer({ pid: 4102, name: "claude" });
        const near = sessionsDir({
            "4102.json": { pid: 4102, sessionId: "near", startedAt: (START_SEC - 120) * 1000 },
        });
        const far = sessionsDir({ "4102.json": { pid: 4102, sessionId: "far", startedAt: (START_SEC - 121) * 1000 } });

        expect(resolveCallerFromPeer({ ...PEER, registryDirOf: () => near }).sessionId).toBe("near");
        expect(resolveCallerFromPeer({ ...PEER, registryDirOf: () => far }).sessionId).toBeNull();
    });

    it("a Claude peer: a stale sessions file from an earlier process with this pid gives no session", () => {
        peer({ pid: 4103, name: "claude" });
        const dir = sessionsDir({
            "4103.json": { pid: 4103, sessionId: "old-process", startedAt: (START_SEC - 86_400) * 1000 },
        });

        const caller = resolveCallerFromPeer({ ...PEER, registryDirOf: () => dir });
        expect(caller.agent).toBe("claude-code");
        expect(caller.sessionId).toBeNull();
        expect(caller.pid).toBe(4103);
    });

    it("a Claude peer: a file for another pid, a missing field or no file gives no session", () => {
        peer({ pid: 4104, name: "claude" });
        const startedAt = START_SEC * 1000;

        expect(
            resolveCallerFromPeer({
                ...PEER,
                registryDirOf: () => sessionsDir({ "4104.json": { pid: 9999, sessionId: "x", startedAt } }),
            }).sessionId
        ).toBeNull();
        expect(
            resolveCallerFromPeer({
                ...PEER,
                registryDirOf: () => sessionsDir({ "4104.json": { pid: 4104, startedAt } }),
            }).sessionId
        ).toBeNull();
        expect(resolveCallerFromPeer({ ...PEER, registryDirOf: () => sessionsDir({}) }).sessionId).toBeNull();
    });

    it("a Codex peer: the session is the one rollout file it holds open", () => {
        const id = "01a0f4fc-171d-7c30-9679-ee00633dee2d";
        peer({
            pid: 4201,
            name: "codex",
            openFiles: [
                "/fixture/.codex/state_5.sqlite",
                `/fixture/.codex/sessions/2026/11/04/rollout-2026-11-04T09-00-00-${id}.jsonl`,
            ],
        });

        expect(resolveCallerFromPeer({ ...PEER })).toEqual({
            agent: "codex",
            sessionId: id,
            cwd: "/fixture/project",
            pid: 4201,
            processName: "codex",
        });
    });

    it("a Codex peer with two rollouts open (an app-server) names no session", () => {
        peer({
            pid: 4202,
            name: "codex",
            openFiles: [
                "/fixture/.codex/sessions/2026/11/04/rollout-2026-11-04T09-00-00-01a0f4fc-171d-7c30-9679-ee00633dee2d.jsonl",
                "/fixture/.codex/sessions/2026/11/04/rollout-2026-11-04T09-05-00-01a0f4fc-0000-7c30-9679-ee00633dee2d.jsonl",
            ],
        });

        expect(resolveCallerFromPeer({ ...PEER })).toMatchObject({ agent: "codex", sessionId: null });
    });

    it("a Grok peer is a Grok caller with no session, whatever files it holds open", () => {
        peer({
            pid: 4301,
            name: "grok",
            openFiles: ["/fixture/.codex/sessions/2026/11/04/rollout-x-01a0f4fc-171d-7c30-9679-ee00633dee2d.jsonl"],
        });

        expect(resolveCallerFromPeer({ ...PEER })).toEqual({
            agent: "grok",
            sessionId: null,
            cwd: "/fixture/project",
            pid: 4301,
            processName: "grok",
        });
    });

    it("a Copilot peer is a Copilot caller with no session", () => {
        peer({ pid: 4401, name: "copilot" });
        expect(resolveCallerFromPeer({ ...PEER })).toMatchObject({ agent: "copilot", sessionId: null, pid: 4401 });
    });

    it("a harness process wins over another process on the same socket", () => {
        fakeProcesses = [
            { pid: 4501, name: "bun", startSec: START_SEC, openFiles: [], cwd: "/fixture/other" },
            { pid: 4502, name: "grok", startSec: START_SEC, openFiles: [], cwd: "/fixture/project" },
        ];
        loopbackOwners = [4501, 4502];

        expect(resolveCallerFromPeer({ ...PEER })).toMatchObject({ agent: "grok", pid: 4502, cwd: "/fixture/project" });
    });

    it("one unnamed owner is an unknown caller that keeps its pid, name and cwd", () => {
        peer({ pid: 4601, name: "node" });
        expect(resolveCallerFromPeer({ ...PEER })).toEqual({
            agent: "unknown",
            sessionId: null,
            cwd: "/fixture/project",
            pid: 4601,
            processName: "node",
        });
    });

    it("no owner, or several unnamed owners, is an unknown caller with nothing filled in", () => {
        const nobody: ResolvedCaller = { agent: "unknown", sessionId: null, cwd: null, pid: null, processName: null };
        fakeProcesses = [];
        loopbackOwners = [];
        expect(resolveCallerFromPeer({ ...PEER })).toEqual(nobody);

        fakeProcesses = [
            { pid: 4701, name: "bun", startSec: START_SEC, openFiles: [], cwd: null },
            { pid: 4702, name: "node", startSec: START_SEC, openFiles: [], cwd: null },
        ];
        loopbackOwners = [4701, 4702];
        expect(resolveCallerFromPeer({ ...PEER })).toEqual(nobody);
    });

    it("a Claude peer keeps an empty, whitespace-only or punctuated session id verbatim", () => {
        peer({ pid: 4801, name: "claude", cwd: null });

        for (const sessionId of ["", " \t\n ", "thread:child%3Amcp/part\\leaf ?#ž"]) {
            const dir = sessionsDir({ "4801.json": { pid: 4801, sessionId, startedAt: START_SEC * 1000 } });
            expect(resolveCallerFromPeer({ ...PEER, registryDirOf: () => dir })).toMatchObject({
                agent: "claude-code",
                sessionId,
                cwd: null,
                pid: 4801,
            });
        }
    });

    it("with several harness owners the one that names its session wins, whatever order the kernel lists them", () => {
        const id = "01a0f4fc-171d-7c30-9679-ee00633dee2d";
        fakeProcesses = [
            { pid: 4802, name: "grok", startSec: START_SEC, openFiles: [], cwd: "/fixture/outer" },
            {
                pid: 4803,
                name: "codex",
                startSec: START_SEC,
                cwd: "/fixture/inner",
                openFiles: [`/fixture/sessions/2026/11/04/rollout-x-${id}.jsonl`],
            },
        ];
        loopbackOwners = [4802, 4803];
        expect(resolveCallerFromPeer(PEER)).toMatchObject({ agent: "codex", sessionId: id, pid: 4803 });
        loopbackOwners = [4803, 4802];
        expect(resolveCallerFromPeer(PEER)).toMatchObject({ agent: "codex", sessionId: id, pid: 4803 });
    });

    it("with several harness owners and no session named, the outer host of the host chain wins, then the lower pid", () => {
        fakeProcesses = [
            { pid: 4905, name: "grok", startSec: START_SEC, openFiles: [], cwd: "/fixture/inner" },
            { pid: 4904, name: "codex", startSec: START_SEC, openFiles: [], cwd: "/fixture/outer" },
            { pid: 4903, name: "grok", startSec: START_SEC, openFiles: [], cwd: "/fixture/other" },
        ];
        loopbackOwners = [4905, 4904, 4903];
        expect(resolveCallerFromPeer(PEER)).toMatchObject({ agent: "codex", sessionId: null, pid: 4904 });
        loopbackOwners = [4905, 4903];
        expect(resolveCallerFromPeer(PEER)).toMatchObject({ agent: "grok", pid: 4903 });
    });

    it("the gateway can name the session of a Claude or Codex caller only", () => {
        expect(callerSessionReadable("claude-code")).toBe(true);
        expect(callerSessionReadable("codex")).toBe(true);
        expect(callerSessionReadable("grok")).toBe(false);
        expect(callerSessionReadable("copilot")).toBe(false);
        expect(callerSessionReadable("unknown")).toBe(false);
    });
});

describe("characterization: rollout path edge cases at the gateway", () => {
    const id = "01a0f4fc-171d-7c30-9679-ee00633dee2d";
    const file = `/fixture/sessions/2026/11/04/rollout-x-${id}.jsonl`;

    it("duplicate files for the same thread are one candidate, with UUID case folded", () => {
        expect(codexThreadIdFromOpenFiles([file.toUpperCase()])).toBe(id);
        expect(codexThreadIdFromOpenFiles([file, file, file.toUpperCase()])).toBe(id);
    });

    it("a compressed rollout names its thread like a plain one, and both forms of one thread are one candidate", () => {
        expect(codexThreadIdFromOpenFiles([`${file}.zst`])).toBe(id);
        expect(codexThreadIdFromOpenFiles([`${file}.zst`, file])).toBe(id);
        expect(codexThreadIdFromOpenFiles([`${file}.gz`])).toBeNull();
    });

    it("Windows separators and non-UUID session strings are not matched today", () => {
        expect(codexThreadIdFromOpenFiles([file.replaceAll("/", "\\")])).toBeNull();
        expect(
            codexThreadIdFromOpenFiles(["/fixture/sessions/2026/11/04/rollout-x-thread:child%3Amcp.jsonl"])
        ).toBeNull();
    });

    it("a peer with only a compressed Codex rollout can still identify its thread", () => {
        fakeProcesses = [
            { pid: 4950, name: "codex", startSec: 1_800_000_000, openFiles: [`${file}.zst`], cwd: "/fixture/project" },
        ];
        loopbackOwners = [4950];
        expect(resolveCallerFromPeer({ clientPort: 50_001, serverPort: 50_002 })).toMatchObject({
            agent: "codex",
            sessionId: id,
            pid: 4950,
        });
    });
});

describe("a remote caller never takes the gateway's own env, terminal or account", () => {
    const PEER = { clientPort: 50_001, serverPort: 50_002 };
    const gatewayEnv: Record<string, string> = {
        CLAUDE_CODE_SESSION_ID: "gateway-own-session",
        CMUX_SURFACE_ID: "gateway-surface",
        TMUX_PANE: "%9",
        T3CODE_THREAD_ID: "gateway-thread",
        [accountEnvVar("claude")]: "gateway-account",
    };

    function withGatewayEnv<T>(fn: () => T): T {
        const saved = { ...process.env };
        Object.assign(process.env, gatewayEnv);

        try {
            return fn();
        } finally {
            for (const key of Object.keys(gatewayEnv)) {
                if (key in saved) {
                    process.env[key] = saved[key];
                } else {
                    delete process.env[key];
                }
            }
        }
    }

    it("positive control: the same env names the gateway itself as a Claude caller when the request is local", () => {
        withGatewayEnv(() => {
            const local = whoIsCalling({ origin: "local", env: process.env });
            expect(local).toMatchObject({ agent: "claude-code", sessionId: "gateway-own-session" });
            expect(local.terminal).toBeDefined();
            expect(local.account).toBeDefined();
        });
    });

    it("a Grok peer on a gateway that runs inside Claude is a Grok caller with no session, terminal or account", () => {
        fakeProcesses = [{ pid: 5001, name: "grok", startSec: 1_800_000_000, openFiles: [], cwd: "/fixture/project" }];
        loopbackOwners = [5001];

        withGatewayEnv(() => {
            const identity = whoIsCalling(
                { origin: "remote", caller: resolveCallerFromPeer(PEER) },
                { facets: ["cwd", "git", "title", "transcript", "model", "host", "process"] }
            );

            expect(identity).toMatchObject({ agent: "grok", sessionId: null, cwd: "/fixture/project" });
            expect(identity.aiAgent).toBeNull();
            expect(identity.terminal).toBeUndefined();
            expect(identity.account).toBeUndefined();
            expect(identity.host).toBeUndefined();
            expect(identity.process?.pid).toBe(5001);
        });
    });

    it("a connection nobody owns is an unknown caller, and the gateway's env fills in nothing", () => {
        fakeProcesses = [];
        loopbackOwners = [];

        withGatewayEnv(() => {
            const identity = whoIsCalling(
                { origin: "remote", caller: resolveCallerFromPeer(PEER) },
                { facets: ["host", "transcript"] }
            );

            expect(identity).toMatchObject({ agent: "unknown", sessionId: null, isInAgent: false });
            expect(identity.terminal).toBeUndefined();
            expect(identity.account).toBeUndefined();
            expect(identity.host).toBeUndefined();
            expect(resolveCallerFromPeer(PEER)).toMatchObject({ agent: "unknown", sessionId: null });
        });
    });
});
