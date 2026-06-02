import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { classifyAgentState } from "./classify";
import { readClaudeSnapshots } from "./sources/claude";
import { collectSnapshots } from "./sources/index";
import { readTaskSnapshots } from "./sources/task";
import { readWorkflowSnapshots } from "./sources/workflows";
import { NOTABLE_STATES, shouldNotify, transitionMessage } from "./transitions";
import type { AgentEvent, AgentSnapshot, AgentState, Notifier } from "./types";
import { decideAndNotify } from "./watcher";

const T0 = 1_000_000_000_000; // fixed injected baseline (epoch ms)

function ev(kind: AgentEvent["kind"], ts: number, extra: Partial<AgentEvent> = {}): AgentEvent {
    return { kind, ts, ...extra };
}

describe("classifyAgentState", () => {
    it("returns FINISHED when the latest event is an exit", () => {
        const events = [ev("start", T0), ev("output", T0 + 100), ev("exit", T0 + 200, { exitCode: 0 })];
        const state = classifyAgentState({ events, lastModified: T0 + 200, now: T0 + 5_000, stallTimeoutMs: 120_000 });
        expect(state).toBe("FINISHED");
    });

    it("returns AWAITING-INPUT when the latest event is a question", () => {
        const events = [ev("output", T0), ev("question", T0 + 50, { text: "May I edit? (y/n)" })];
        const state = classifyAgentState({ events, lastModified: T0 + 50, now: T0 + 60, stallTimeoutMs: 120_000 });
        expect(state).toBe("AWAITING-INPUT");
    });

    it("returns STALLED when alive and no output past the timeout", () => {
        const events = [ev("output", T0)];
        const state = classifyAgentState({
            events,
            lastModified: T0,
            now: T0 + 200_000,
            stallTimeoutMs: 120_000,
            pidAlive: true,
        });
        expect(state).toBe("STALLED");
    });

    it("returns RUNNING when recent output and within the timeout", () => {
        const events = [ev("output", T0)];
        const state = classifyAgentState({ events, lastModified: T0, now: T0 + 5_000, stallTimeoutMs: 120_000 });
        expect(state).toBe("RUNNING");
    });

    it("reclassifies a dead-pid RUNNING agent as FINISHED", () => {
        const events = [ev("output", T0)];
        const state = classifyAgentState({
            events,
            lastModified: T0,
            now: T0 + 5_000,
            stallTimeoutMs: 120_000,
            pidAlive: false,
        });
        expect(state).toBe("FINISHED");
    });

    it("prefers an explicit exit event over a dead-pid hint (still FINISHED)", () => {
        const events = [ev("exit", T0, { exitCode: 1 })];
        const state = classifyAgentState({
            events,
            lastModified: T0,
            now: T0 + 5_000,
            stallTimeoutMs: 120_000,
            pidAlive: false,
        });
        expect(state).toBe("FINISHED");
    });

    it("question wins over stall (awaiting input is not a stall)", () => {
        const events = [ev("question", T0)];
        const state = classifyAgentState({
            events,
            lastModified: T0,
            now: T0 + 999_999,
            stallTimeoutMs: 120_000,
            pidAlive: true,
        });
        expect(state).toBe("AWAITING-INPUT");
    });

    it("treats an agent with no events as RUNNING when fresh, STALLED when stale+alive", () => {
        expect(classifyAgentState({ events: [], lastModified: T0, now: T0 + 1_000, stallTimeoutMs: 120_000 })).toBe(
            "RUNNING"
        );
        expect(
            classifyAgentState({
                events: [],
                lastModified: T0,
                now: T0 + 200_000,
                stallTimeoutMs: 120_000,
                pidAlive: true,
            })
        ).toBe("STALLED");
    });
});

describe("shouldNotify", () => {
    it("notifies on transition into a notable state from a different state", () => {
        expect(shouldNotify("RUNNING", "FINISHED")).toBe(true);
        expect(shouldNotify("RUNNING", "STALLED")).toBe(true);
        expect(shouldNotify("RUNNING", "AWAITING-INPUT")).toBe(true);
    });

    it("notifies on first sighting that is already notable (prev undefined)", () => {
        expect(shouldNotify(undefined, "FINISHED")).toBe(true);
        expect(shouldNotify(undefined, "AWAITING-INPUT")).toBe(true);
    });

    it("does NOT notify for a first sighting of RUNNING", () => {
        expect(shouldNotify(undefined, "RUNNING")).toBe(false);
    });

    it("does NOT notify when state is unchanged", () => {
        expect(shouldNotify("RUNNING", "RUNNING")).toBe(false);
        expect(shouldNotify("STALLED", "STALLED")).toBe(false);
        expect(shouldNotify("FINISHED", "FINISHED")).toBe(false);
    });

    it("does NOT notify when leaving a notable state into RUNNING (recovery is quiet)", () => {
        expect(shouldNotify("STALLED", "RUNNING")).toBe(false);
        expect(shouldNotify("AWAITING-INPUT", "RUNNING")).toBe(false);
    });

    it("notifies when moving between two different notable states", () => {
        expect(shouldNotify("STALLED", "FINISHED")).toBe(true);
        expect(shouldNotify("AWAITING-INPUT", "FINISHED")).toBe(true);
    });
});

describe("transitionMessage", () => {
    const base: AgentSnapshot = {
        id: "task:checks-6984",
        name: "checks-6984",
        source: "task",
        state: "FINISHED",
        lastOutputAt: 1,
        ageMs: 0,
        exitCode: 0,
        lastLine: "===== ALL STEPS DONE =====",
    };

    it("includes the agent name and the new state", () => {
        const msg = transitionMessage(base);
        expect(msg.title).toContain("checks-6984");
        expect(msg.message).toContain("finished");
    });

    it("surfaces a non-zero exit code on FINISHED", () => {
        const msg = transitionMessage({ ...base, exitCode: 2 });
        expect(msg.message).toContain("2");
    });

    it("NOTABLE_STATES excludes RUNNING", () => {
        expect(NOTABLE_STATES.has("RUNNING")).toBe(false);
        expect(NOTABLE_STATES.has("FINISHED")).toBe(true);
    });
});

describe("readTaskSnapshots", () => {
    function makeSessionDir(): string {
        const dir = mkdtempSync(join(tmpdir(), "agent-watch-task-"));
        const finished = [
            { type: "meta", session: "checks-1", command: "bash run.sh", startedAt: "2026-06-02T01:34:49.745Z" },
            { type: "line", seq: 1, out: "stdout", level: "info", ts: T0 + 10, text: "starting" },
            { type: "line", seq: 2, out: "stdout", level: "info", ts: T0 + 20, text: "===== DONE =====" },
            { type: "exit", code: 0, durationMs: 100, ts: "2026-06-02T01:35:45.927Z" },
        ];
        writeFileSync(join(dir, "checks-1.jsonl"), `${finished.map((o) => SafeJSON.stringify(o)).join("\n")}\n`);
        writeFileSync(
            join(dir, "checks-1.meta.json"),
            SafeJSON.stringify({ name: "checks-1", pid: 4242, exitCode: 0, lastActivityAt: T0 + 20 })
        );
        const running = [
            { type: "meta", session: "dev-2", command: "vite", startedAt: "2026-06-02T01:40:00.000Z" },
            { type: "line", seq: 1, out: "stdout", level: "info", ts: T0 + 50, text: "VITE ready" },
        ];
        writeFileSync(join(dir, "dev-2.jsonl"), `${running.map((o) => SafeJSON.stringify(o)).join("\n")}\n`);
        writeFileSync(
            join(dir, "dev-2.meta.json"),
            SafeJSON.stringify({ name: "dev-2", pid: 1, lastActivityAt: T0 + 50 })
        );
        return dir;
    }

    it("reads finished and running sessions from a session dir", async () => {
        const dir = makeSessionDir();

        try {
            const snaps = await readTaskSnapshots({ dir, now: T0 + 1_000, stallTimeoutMs: 120_000 });
            const byName = new Map(snaps.map((s) => [s.name, s]));

            expect(byName.get("checks-1")?.state).toBe("FINISHED");
            expect(byName.get("checks-1")?.exitCode).toBe(0);
            expect(byName.get("checks-1")?.lastLine).toBe("===== DONE =====");
            expect(byName.get("checks-1")?.id).toBe("task:checks-1");

            // pid 1 (launchd/init) is alive but not ours; events are recent → RUNNING
            expect(byName.get("dev-2")?.state).toBe("RUNNING");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns [] for a non-existent dir without throwing", async () => {
        const snaps = await readTaskSnapshots({
            dir: join(tmpdir(), "agent-watch-does-not-exist-xyz"),
            now: T0,
            stallTimeoutMs: 120_000,
        });
        expect(snaps).toEqual([]);
    });
});

describe("claude/workflows adapters tolerate a missing root", () => {
    it("return [] when their root does not exist", async () => {
        const missing = join(tmpdir(), "agent-watch-missing-root-abc");
        expect(await readClaudeSnapshots({ root: missing, now: T0, stallTimeoutMs: 120_000 })).toEqual([]);
        expect(await readWorkflowSnapshots({ root: missing, now: T0, stallTimeoutMs: 120_000 })).toEqual([]);
    });
});

describe("collectSnapshots", () => {
    it("honors the sources filter and returns [] for empty injected roots (hermetic)", async () => {
        const empty = mkdtempSync(join(tmpdir(), "agent-watch-empty-"));

        try {
            const snaps = await collectSnapshots({
                sources: ["task", "claude", "workflows"],
                now: T0,
                stallTimeoutMs: 120_000,
                roots: { task: empty, claude: empty, workflow: empty },
            });
            expect(snaps).toEqual([]);
        } finally {
            rmSync(empty, { recursive: true, force: true });
        }
    });
});

describe("decideAndNotify (notify decision against a stub)", () => {
    function stubNotifier(): { notifier: Notifier; calls: { title: string; message: string }[] } {
        const calls: { title: string; message: string }[] = [];
        const notifier: Notifier = {
            notify: async ({ title, message }) => {
                calls.push({ title, message });
            },
        };
        return { notifier, calls };
    }

    it("fires once on RUNNING→FINISHED and not again while it stays FINISHED", async () => {
        const { notifier, calls } = stubNotifier();
        const prev = new Map<string, AgentState>();
        prev.set("task:a", "RUNNING");

        const finished: AgentSnapshot = {
            id: "task:a",
            name: "a",
            source: "task",
            state: "FINISHED",
            lastOutputAt: 1,
            ageMs: 0,
            exitCode: 0,
        };

        await decideAndNotify({ snapshots: [finished], prevStates: prev, notifier });
        await decideAndNotify({ snapshots: [finished], prevStates: prev, notifier });

        expect(calls).toHaveLength(1);
        expect(calls[0].message).toContain("finished");
        expect(prev.get("task:a")).toBe("FINISHED");
    });

    it("does NOT fire for a first-sighting RUNNING agent", async () => {
        const { notifier, calls } = stubNotifier();
        const prev = new Map<string, AgentState>();
        const running: AgentSnapshot = {
            id: "task:b",
            name: "b",
            source: "task",
            state: "RUNNING",
            lastOutputAt: 1,
            ageMs: 0,
        };

        await decideAndNotify({ snapshots: [running], prevStates: prev, notifier });

        expect(calls).toHaveLength(0);
    });
});
