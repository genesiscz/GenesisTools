import { afterEach, describe, expect, test } from "bun:test";
import { statusOf } from "./discover";
import { __setPsRunnerForTest, listLiveTeammateProcesses, type PsResult, readProcessEnvKeys } from "./status";
import type { TeamMemberConfig, TeammateTranscriptRef } from "./types";

function psOk(stdout: string): PsResult {
    return { exitCode: 0, stdout, stderr: "" };
}

function psFail(stderr = "ps: operation not permitted"): PsResult {
    return { exitCode: 1, stdout: "", stderr };
}

const TEAMMATE_LINE =
    "  4242   4200 /Users/x/.bun/bin/claude --agent-id mate@session-abc --agent-name mate --team-name session-abc";

const MEMBER: TeamMemberConfig = { agentId: "mate@session-abc", name: "mate" };

const TRANSCRIPT: TeammateTranscriptRef = {
    sessionId: "bad27373",
    path: "/tmp/x.jsonl",
    mtimeMs: Date.now(),
    hasLeadAssignment: true,
    messageCount: 2,
};

afterEach(() => {
    __setPsRunnerForTest(null);
});

describe("listLiveTeammateProcesses reports scan failure distinctly", () => {
    test("a successful scan with no claude processes is not a failure", () => {
        __setPsRunnerForTest(() => psOk("  1   0 /sbin/launchd\n"));

        expect(listLiveTeammateProcesses()).toEqual({ processes: [], failed: false });
    });

    test("a nonzero ps exit is a failure, not an empty process table", () => {
        // Both cases yield zero processes; only the flag tells them apart, and
        // that difference is what keeps a live teammate from rendering as dead.
        __setPsRunnerForTest(() => psFail());

        expect(listLiveTeammateProcesses()).toEqual({ processes: [], failed: true });
    });

    test("a ps that cannot be spawned at all is also a failure", () => {
        __setPsRunnerForTest(() => {
            throw new Error("spawn ENOENT");
        });

        expect(listLiveTeammateProcesses()).toEqual({ processes: [], failed: true });
    });

    test("a successful scan parses teammate identity flags", () => {
        __setPsRunnerForTest(() => psOk(`${TEAMMATE_LINE}\n`));

        const scan = listLiveTeammateProcesses();

        expect(scan.failed).toBe(false);
        expect(scan.processes).toHaveLength(1);
        expect(scan.processes[0]).toMatchObject({
            pid: 4242,
            agentId: "mate@session-abc",
            agentName: "mate",
            teamName: "session-abc",
        });
    });
});

describe("statusOf does not report a teammate dead on a failed scan", () => {
    test("no live match after a SUCCESSFUL scan means dead", () => {
        expect(statusOf({ isLead: false, transcript: TRANSCRIPT, member: MEMBER, scanFailed: false })).toBe("dead");
    });

    test("no live match after a FAILED scan means unknown", () => {
        expect(statusOf({ isLead: false, transcript: TRANSCRIPT, member: MEMBER, scanFailed: true })).toBe("unknown");
    });

    test("config-declared inactive still means dead — it does not depend on the scan", () => {
        expect(
            statusOf({
                isLead: false,
                transcript: TRANSCRIPT,
                member: { ...MEMBER, isActive: false },
                scanFailed: true,
            })
        ).toBe("dead");
    });

    test("an auth failure in the transcript still wins over the failed scan", () => {
        const transcript: TeammateTranscriptRef = {
            ...TRANSCRIPT,
            lastMessage: { role: "assistant", text: "Not logged in" },
        };

        expect(statusOf({ isLead: false, transcript, member: MEMBER, scanFailed: true })).toBe("not-logged-in");
    });

    test("a matched live process is running regardless of the flag", () => {
        const live = {
            pid: 1,
            cmdline: "claude",
            agentId: "mate@session-abc",
            agentName: "mate",
            teamName: "session-abc",
        };

        expect(statusOf({ isLead: false, live, transcript: TRANSCRIPT, member: MEMBER, scanFailed: true })).toBe(
            "running"
        );
    });
});

describe("readProcessEnvKeys falls back rather than inventing an account", () => {
    test("reads the requested key from a successful ps", () => {
        __setPsRunnerForTest(() => psOk("  PID TTY  TOOLS_CLAUDE_ACCOUNT=max-primary OTHER=x\n"));

        expect(readProcessEnvKeys(4242, ["TOOLS_CLAUDE_ACCOUNT"])).toEqual({ TOOLS_CLAUDE_ACCOUNT: "max-primary" });
    });

    test("a nonzero exit yields no keys, so callers fall back to the default account", () => {
        __setPsRunnerForTest(() => psFail());

        expect(readProcessEnvKeys(4242, ["TOOLS_CLAUDE_ACCOUNT"])).toEqual({});
    });

    test("a missing key is simply absent", () => {
        __setPsRunnerForTest(() => psOk("  PID TTY  SOMETHING_ELSE=1\n"));

        expect(readProcessEnvKeys(4242, ["TOOLS_CLAUDE_ACCOUNT"])).toEqual({});
    });
});
