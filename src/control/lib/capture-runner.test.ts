import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { validateNativeCapturePlan } from "./capture-native";
import type { Plan } from "./capture-plan";
import type { CaptureAttempt } from "./peekaboo";

/**
 * The recorder child is a fake: `startCapture` returns it, and `killTree` only records the pid,
 * so these tests never spawn a recorder or signal a real process. Plans use the peekaboo
 * backend with a 2x2 region so a stub that stopped intercepting could not record a screen.
 */
const realPeekaboo = await import("./peekaboo");
type StartCapture = (argv: string[], signal?: AbortSignal) => Promise<CaptureAttempt>;
let startImpl: StartCapture = async () => {
    throw new Error("stub: no recorder is started from tests");
};
const startCalls: string[][] = [];
const killed: number[] = [];
let onKill: (pid: number) => void = () => {};
const published: unknown[][] = [];

mock.module("./peekaboo", () => ({
    ...realPeekaboo,
    startCapture: (argv: string[], signal?: AbortSignal) => {
        startCalls.push(argv);
        return startImpl(argv, signal);
    },
    killTree: (pid: number) => {
        killed.push(pid);
        onKill(pid);
    },
}));
mock.module("./vitrinka-publish", () => ({
    publishVitrinka: (...args: unknown[]) => {
        published.push(args);
        return { ok: true, urls: ["https://example.invalid/board"] };
    },
}));

const { CaptureRunError, peekabooDurationArg, recorderFailed, runCapturePlan, runCapturePlanWithSignal } = await import(
    "./capture-runner"
);

// Regression: PR #376 review round 3 — plan durations reached peekaboo unconverted.
// `capture-plan.ts` documents `capture.duration` in SECONDS, but peekaboo reads a bare
// `--duration` as MILLISECONDS ("Duration; bare values are milliseconds" in
// `peekaboo capture live --help`), so a `duration: 2` plan asked for a 2 ms recording
// while the runner's own exit wait blocked for ~2 s.

test("a plan duration reaches peekaboo as seconds, not as a bare millisecond count", () => {
    expect(peekabooDurationArg(2)).toBe("2s");
    expect(peekabooDurationArg(9)).toBe("9s");
});

test("the argument is never a bare number, which peekaboo would read as milliseconds", () => {
    for (const seconds of [1, 2, 3, 30, 180]) {
        expect(peekabooDurationArg(seconds)).not.toBe(String(seconds));
        expect(peekabooDurationArg(seconds)).toMatch(/^\d+(\.\d+)?s$/);
    }
});

test("a fractional duration keeps its unit rather than truncating to milliseconds", () => {
    expect(peekabooDurationArg(1.5)).toBe("1.5s");
});

const sessionsRoot = mkdtempSync(join(tmpdir(), "capture-runner-test-"));
afterAll(() => {
    rmSync(sessionsRoot, { recursive: true, force: true });
});

interface FakeRecorder {
    attempt: CaptureAttempt;
    signals: string[];
    finish: (code: number) => void;
}

/** A recorder child that exits on SIGINT unless told not to, printing `envelope` on exit. */
function fakeRecorder(options: { envelope: unknown; exitOnSigint?: boolean }): FakeRecorder {
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
    });
    const signals: string[] = [];
    const proc = {
        pid: 990_001,
        exitCode: null as number | null,
        exited,
        kill(signal?: number | NodeJS.Signals) {
            signals.push(String(signal));
            if (options.exitOnSigint ?? true) {
                finish(0);
            }
        },
    };
    const finish = (code: number) => {
        if (proc.exitCode === null) {
            proc.exitCode = code;
            resolveExit(code);
        }
    };
    const attempt = {
        proc,
        sessionDir: mkdtempSync(join(sessionsRoot, "session-")),
        stdoutText: exited.then(() => SafeJSON.stringify(options.envelope)),
        stderrText: Promise.resolve(""),
        failDiag: "",
        tool: "peekaboo",
    };
    // The one cast in this file: a test double stands in for Bun's Subprocess.
    return { attempt: attempt as unknown as CaptureAttempt, signals, finish };
}

function regionPlan(extra: Partial<Plan> = {}): Plan {
    return {
        capture: { mode: "region", region: "0,0,2,2", duration: 1, backend: "peekaboo" },
        actions: [],
        ...extra,
    };
}

function reset(recorder?: FakeRecorder): void {
    startCalls.length = 0;
    killed.length = 0;
    published.length = 0;
    onKill = (pid) => {
        if (recorder && pid === recorder.attempt.proc.pid) {
            recorder.finish(137);
        }
    };
    startImpl = async () => {
        if (!recorder) {
            throw new Error("stub: no recorder is started from tests");
        }

        return recorder.attempt;
    };
}

describe("recorder lifetime", () => {
    test("a recorder that exits 0 with an ok envelope completes the run", async () => {
        const recorder = fakeRecorder({ envelope: { ok: true, data: { frames: [] } } });
        reset(recorder);
        recorder.finish(0);
        const result = await runCapturePlanWithSignal({ plan: regionPlan(), signal: new AbortController().signal });
        expect(result.ok).toBe(true);
        expect(result.captureFailed).toBe(false);
        expect(recorder.signals).toEqual([]);
        expect(killed).toEqual([]);
    });

    test("a failed native envelope fails the run and nothing salvaged is published", async () => {
        const frames = [{ file: "keep-0001.png", path: "/nonexistent/keep-0001.png", timestampMs: 0 }];
        const recorder = fakeRecorder({ envelope: { ok: false, success: false, data: { frames } } });
        reset(recorder);
        recorder.finish(1);
        const result = await runCapturePlanWithSignal({
            plan: regionPlan({ vitrinka: { project: "fixture", key: "fixture-set" } }),
            signal: new AbortController().signal,
        });
        expect(result.captureFailed).toBe(true);
        expect(result.ok).toBe(false);
        expect(published).toEqual([]);
        expect(result.vitrinka?.error).toContain("failed recording");
        expect(recorderFailed({ ok: true }, 2)).toBe(true);
        expect(recorderFailed({ ok: true }, 0)).toBe(false);
    });

    test("cancelling during a timed wait stops the recorder with SIGINT and skips the rest", async () => {
        const recorder = fakeRecorder({ envelope: { ok: true, cancelled: true, data: { frames: [] } } });
        reset(recorder);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        const started = Date.now();
        const result = await runCapturePlanWithSignal({
            plan: regionPlan({ actions: [{ atMs: 5_000, do: "focus-stop" }] }),
            signal: controller.signal,
        });
        expect(Date.now() - started).toBeLessThan(4_000);
        expect(recorder.signals).toEqual(["SIGINT"]);
        expect(killed).toEqual([]);
        expect(result.actions[0]).toMatchObject({ skipped: true, ok: false });
        expect(result.warnings).toContain("Recording cancelled; remaining actions were skipped.");
        expect(result.ok).toBe(false);
    });

    test("a recorder that ignores SIGINT is killed once the grace period ends", async () => {
        const recorder = fakeRecorder({ envelope: { ok: true, data: { frames: [] } }, exitOnSigint: false });
        reset(recorder);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        const result = await runCapturePlanWithSignal({
            plan: regionPlan({ actions: [{ atMs: 5_000, do: "focus-stop" }] }),
            signal: controller.signal,
            stopGraceMs: 30,
        });
        expect(recorder.signals).toEqual(["SIGINT"]);
        expect(killed).toEqual([recorder.attempt.proc.pid]);
        expect(result.captureFailed).toBe(true);
    });

    test("a run cancelled before startup never starts a recorder", async () => {
        reset();
        const controller = new AbortController();
        controller.abort();
        const run = runCapturePlanWithSignal({ plan: regionPlan(), signal: controller.signal });
        await expect(run).rejects.toBeInstanceOf(CaptureRunError);
        await expect(run).rejects.toMatchObject({ exitCode: 130 });
        expect(startCalls).toEqual([]);
    });

    test("cancelling while the recorder arms reports cancellation and does not retry another transport", async () => {
        reset();
        const controller = new AbortController();
        startImpl = async (_argv, signal) => {
            controller.abort();
            expect(signal?.aborted).toBe(true);
            const recorder = fakeRecorder({ envelope: {} });
            recorder.finish(130);
            return { ...recorder.attempt, sessionDir: null, failDiag: "cancelled while arming" };
        };
        const run = runCapturePlanWithSignal({ plan: regionPlan(), signal: controller.signal });
        await expect(run).rejects.toThrow("Recording cancelled while the recorder was arming");
        expect(startCalls).toHaveLength(1);
    });

    test("an arming recorder that honours SIGINT is stopped without killing its tree", async () => {
        const recorder = fakeRecorder({ envelope: {} });
        await realPeekaboo.stopArmingRecorder(recorder.attempt.proc, 1_000);
        expect(recorder.signals).toEqual(["SIGINT"]);
        expect(recorder.attempt.proc.exitCode).toBe(0);
    });
});

test("native recording rejects scripting and unsupported typing before recorder startup", async () => {
    const base = { capture: { mode: "screen" as const, duration: 1 }, actions: [] };
    for (const action of [
        { atMs: 0, do: "osascript" as const, script: 'error "must never run"' },
        { atMs: 0, do: "url" as const, url: "https://example.com" },
        { atMs: 0, do: "hotkey" as const, keys: "volumeup" },
        { atMs: 0, do: "type" as const, text: "line one\nline two" },
    ]) {
        await expect(runCapturePlan({ ...base, actions: [action] })).rejects.toThrow(/unavailable|single-line/);
    }
    expect(() =>
        validateNativeCapturePlan({ ...base, actions: [{ atMs: 0, do: "ax-press", app: "Fixture", axId: "save" }] })
    ).not.toThrow();
});
