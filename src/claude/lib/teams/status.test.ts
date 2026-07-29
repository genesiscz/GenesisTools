import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "@genesiscz/utils/logger";
import { statusOf } from "./discover";
import {
    __setPsRunnerForTest,
    listLiveTeammateProcesses,
    type PsResult,
    type PsRunner,
    readProcessEnvKeys,
} from "./status";
import type { TeamMemberConfig, TeammateTranscriptRef } from "./types";

function psOk(stdout: string): PsResult {
    return { exitCode: 0, stdout, stderr: "" };
}

function psFail(stderr = "ps: operation not permitted"): PsResult {
    return { exitCode: 1, stdout: "", stderr };
}

/**
 * Install the `ps` seam for exactly one call and restore it immediately. Scoped
 * rather than hook-based so each test states the runner it depends on, and the
 * shared module-level seam is never left installed past the line that needed it.
 */
function withPsRunner<T>(runner: PsRunner, fn: () => T): T {
    __setPsRunnerForTest(runner);

    try {
        return fn();
    } finally {
        __setPsRunnerForTest(null);
    }
}

interface CapturedWarning {
    context: Record<string, unknown>;
    message: string;
}

/**
 * Warnings are part of the contract here: a silent scan failure is the bug.
 *
 * The arguments are copied into our own array as the call happens rather than read
 * back from `mock.calls` afterwards, which keeps the assertions independent of how
 * long Bun retains recorded call arguments. Replacing the implementation also keeps
 * the deliberate failures out of the suite's output.
 */
function capturingWarnings<T>(fn: () => T): { result: T; warnings: CapturedWarning[] } {
    const warnings: CapturedWarning[] = [];
    const warn = spyOn(logger, "warn").mockImplementation(((context: Record<string, unknown>, message: string) => {
        warnings.push({ context, message });
    }) as never);

    try {
        return { result: fn(), warnings };
    } finally {
        warn.mockRestore();
    }
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

describe("listLiveTeammateProcesses reports scan failure distinctly", () => {
    test("a successful scan with no claude processes is not a failure", () => {
        const scan = withPsRunner(
            () => psOk("  1   0 /sbin/launchd\n"),
            () => listLiveTeammateProcesses()
        );

        expect(scan).toEqual({ processes: [], failed: false });
    });

    test("a nonzero ps exit is a failure, not an empty process table, and warns", () => {
        // Both cases yield zero processes; only the flag tells them apart, and
        // that difference is what keeps a live teammate from rendering as dead.
        const { result, warnings } = capturingWarnings(() =>
            withPsRunner(
                () => psFail(),
                () => listLiveTeammateProcesses()
            )
        );

        expect(result).toEqual({ processes: [], failed: true });
        expect(warnings).toHaveLength(1);
        expect(warnings[0].context).toMatchObject({ exitCode: 1, stderr: "ps: operation not permitted" });
        expect(warnings[0].message).toContain("ps -ax failed");
    });

    test("a ps that cannot be spawned at all is also a failure, and warns with the error", () => {
        // A regression that dropped the logger.warn would still return the right
        // shape, so the diagnostic itself is asserted rather than assumed.
        const { result, warnings } = capturingWarnings(() =>
            withPsRunner(
                () => {
                    throw new Error("spawn ENOENT");
                },
                () => listLiveTeammateProcesses()
            )
        );

        expect(result).toEqual({ processes: [], failed: true });
        expect(warnings).toHaveLength(1);
        expect(warnings[0].message).toContain("could not be spawned");
        // The thrown error itself must reach the log, not just a generic notice.
        expect((warnings[0].context.error as Error).message).toBe("spawn ENOENT");
    });

    test("a successful scan parses teammate identity flags and warns about nothing", () => {
        const { result, warnings } = capturingWarnings(() =>
            withPsRunner(
                () => psOk(`${TEAMMATE_LINE}\n`),
                () => listLiveTeammateProcesses()
            )
        );

        expect(warnings).toEqual([]);
        expect(result.failed).toBe(false);
        expect(result.processes).toHaveLength(1);
        expect(result.processes[0]).toMatchObject({
            pid: 4242,
            agentId: "mate@session-abc",
            agentName: "mate",
            teamName: "session-abc",
        });
    });

    test("the seam never outlives the call that installed it", () => {
        withPsRunner(
            () => psFail(),
            () => listLiveTeammateProcesses()
        );

        // Back on the real runner: this machine has a readable process table, so a
        // leaked stub would show up here as a spurious failed scan.
        expect(listLiveTeammateProcesses().failed).toBe(false);
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
        const keys = withPsRunner(
            () => psOk("  PID TTY  TOOLS_CLAUDE_ACCOUNT=max-primary OTHER=x\n"),
            () => readProcessEnvKeys(4242, ["TOOLS_CLAUDE_ACCOUNT"])
        );

        expect(keys).toEqual({ TOOLS_CLAUDE_ACCOUNT: "max-primary" });
    });

    test("a nonzero exit yields no keys, so callers fall back to the default account", () => {
        const keys = withPsRunner(
            () => psFail(),
            () => readProcessEnvKeys(4242, ["TOOLS_CLAUDE_ACCOUNT"])
        );

        expect(keys).toEqual({});
    });

    test("a missing key is simply absent", () => {
        const keys = withPsRunner(
            () => psOk("  PID TTY  SOMETHING_ELSE=1\n"),
            () => readProcessEnvKeys(4242, ["TOOLS_CLAUDE_ACCOUNT"])
        );

        expect(keys).toEqual({});
    });
});
