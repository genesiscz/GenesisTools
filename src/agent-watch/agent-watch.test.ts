import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
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
        const missingTaskRoot = join(tmpdir(), `agent-watch-missing-${process.pid}-${Date.now()}-task`);
        rmSync(missingTaskRoot, { recursive: true, force: true });

        const snaps = await readTaskSnapshots({
            dir: missingTaskRoot,
            now: T0,
            stallTimeoutMs: 120_000,
        });
        expect(snaps).toEqual([]);
    });
});

describe("claude/workflows adapters tolerate a missing root", () => {
    it("return [] when their root does not exist", async () => {
        const missing = join(tmpdir(), `agent-watch-missing-${process.pid}-${Date.now()}-root`);
        rmSync(missing, { recursive: true, force: true });
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

describe("readClaudeSnapshots (event mapping)", () => {
    function writeSession(dir: string, name: string, records: object[]): void {
        writeFileSync(join(dir, "proj", `${name}.jsonl`), `${records.map((o) => SafeJSON.stringify(o)).join("\n")}\n`);
    }

    function makeClaudeRoot(): string {
        const root = mkdtempSync(join(tmpdir(), "agent-watch-claude-"));
        mkdirSync(join(root, "proj"));
        return root;
    }

    const iso = (offset: number): string => new Date(T0 + offset).toISOString();

    it("does NOT treat a leading summary (compacted session) as FINISHED", async () => {
        const root = makeClaudeRoot();

        try {
            writeSession(root, "compacted", [
                { type: "summary", summary: "earlier context", leafUuid: "x" },
                { type: "user", timestamp: iso(10) },
                { type: "assistant", timestamp: iso(20), message: { stop_reason: "tool_use", content: [] } },
            ]);
            const snaps = await readClaudeSnapshots({ root, now: T0 + 1_000, stallTimeoutMs: 120_000 });
            expect(snaps[0]?.state).toBe("RUNNING");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("treats only a TRAILING result record as FINISHED", async () => {
        const root = makeClaudeRoot();

        try {
            writeSession(root, "done", [
                { type: "user", timestamp: iso(10) },
                { type: "result", timestamp: iso(500) },
            ]);
            writeSession(root, "mid-result", [
                { type: "result", timestamp: iso(10) },
                { type: "assistant", timestamp: iso(500), message: { stop_reason: "tool_use", content: [] } },
            ]);
            const snaps = await readClaudeSnapshots({ root, now: T0 + 1_000, stallTimeoutMs: 120_000 });
            const byName = new Map(snaps.map((s) => [s.name, s]));
            expect(byName.get("done")?.state).toBe("FINISHED");
            expect(byName.get("mid-result")?.state).toBe("RUNNING");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("classifies an ended turn (stop_reason end_turn) as AWAITING-INPUT", async () => {
        const root = makeClaudeRoot();

        try {
            writeSession(root, "idle-at-prompt", [
                { type: "user", timestamp: iso(10) },
                { type: "assistant", timestamp: iso(400), message: { stop_reason: "end_turn", content: [] } },
            ]);
            const snaps = await readClaudeSnapshots({ root, now: T0 + 1_000, stallTimeoutMs: 120_000 });
            expect(snaps[0]?.state).toBe("AWAITING-INPUT");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("classifies a trailing AskUserQuestion tool_use as AWAITING-INPUT even mid-turn", async () => {
        const root = makeClaudeRoot();

        try {
            writeSession(root, "asking", [
                { type: "user", timestamp: iso(10) },
                {
                    type: "assistant",
                    timestamp: iso(400),
                    message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "AskUserQuestion" }] },
                },
            ]);
            const snaps = await readClaudeSnapshots({ root, now: T0 + 1_000, stallTimeoutMs: 120_000 });
            expect(snaps[0]?.state).toBe("AWAITING-INPUT");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("readTaskSnapshots meta sidecar", () => {
    it("marks a session FINISHED via meta.exitCode even without a jsonl exit line", async () => {
        const dir = mkdtempSync(join(tmpdir(), "agent-watch-task-meta-"));

        try {
            const lines = [
                { type: "meta", session: "crashy", command: "bash x.sh", startedAt: "2026-06-02T01:34:49.745Z" },
                { type: "line", seq: 1, out: "stdout", level: "info", ts: T0 + 10, text: "boom" },
            ];
            writeFileSync(join(dir, "crashy.jsonl"), `${lines.map((o) => SafeJSON.stringify(o)).join("\n")}\n`);
            writeFileSync(
                join(dir, "crashy.meta.json"),
                SafeJSON.stringify({ name: "crashy", pid: 999999, exitCode: 137 })
            );

            const snaps = await readTaskSnapshots({ dir, now: T0 + 1_000, stallTimeoutMs: 120_000 });
            expect(snaps[0]?.state).toBe("FINISHED");
            expect(snaps[0]?.exitCode).toBe(137);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("collectSnapshots active window", () => {
    it("drops agents whose last activity is outside activeWindowMs", async () => {
        const dir = mkdtempSync(join(tmpdir(), "agent-watch-window-"));

        try {
            const old = [{ type: "line", seq: 1, out: "stdout", level: "info", ts: T0 - 10_000_000, text: "ancient" }];
            const fresh = [{ type: "line", seq: 1, out: "stdout", level: "info", ts: T0 - 1_000, text: "recent" }];
            writeFileSync(join(dir, "ancient.jsonl"), `${old.map((o) => SafeJSON.stringify(o)).join("\n")}\n`);
            writeFileSync(join(dir, "recent.jsonl"), `${fresh.map((o) => SafeJSON.stringify(o)).join("\n")}\n`);
            // lastOutputAt = max(event ts, mtime) — age the mtimes to match the fixture clock.
            utimesSync(join(dir, "ancient.jsonl"), (T0 - 10_000_000) / 1000, (T0 - 10_000_000) / 1000);
            utimesSync(join(dir, "recent.jsonl"), (T0 - 1_000) / 1000, (T0 - 1_000) / 1000);

            const all = await collectSnapshots({
                sources: ["task"],
                now: T0,
                stallTimeoutMs: 120_000,
                roots: { task: dir },
            });
            const windowed = await collectSnapshots({
                sources: ["task"],
                now: T0,
                stallTimeoutMs: 120_000,
                activeWindowMs: 60_000,
                roots: { task: dir },
            });

            expect(all.map((s) => s.name).sort()).toEqual(["ancient", "recent"]);
            expect(windowed.map((s) => s.name)).toEqual(["recent"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("sweep seed silence (continuous watch baseline)", () => {
    it("notify:false populates prevStates without calling the notifier; next sweep only fires real transitions", async () => {
        const dir = mkdtempSync(join(tmpdir(), "agent-watch-seed-"));

        try {
            const finished = [
                { type: "line", seq: 1, out: "stdout", level: "info", ts: T0 - 500, text: "done long ago" },
                { type: "exit", code: 0, durationMs: 10, ts: T0 - 400 },
            ];
            writeFileSync(join(dir, "old-done.jsonl"), `${finished.map((o) => SafeJSON.stringify(o)).join("\n")}\n`);

            const calls: string[] = [];
            const notifier: Notifier = {
                notify: async ({ message }) => {
                    calls.push(message);
                },
            };
            const prev = new Map<string, AgentState>();

            // Hermetic: same decide flow the watcher's seed pass runs, silent notifier.
            const seedSnaps = await collectSnapshots({
                sources: ["task"],
                now: T0,
                stallTimeoutMs: 120_000,
                roots: { task: dir },
            });
            await decideAndNotify({ snapshots: seedSnaps, prevStates: prev, notifier: { notify: async () => {} } });
            expect(calls).toHaveLength(0);
            expect(prev.get("task:old-done")).toBe("FINISHED");

            // Second pass with the REAL notifier: state unchanged → still quiet.
            const again = await collectSnapshots({
                sources: ["task"],
                now: T0 + 1_000,
                stallTimeoutMs: 120_000,
                roots: { task: dir },
            });
            await decideAndNotify({ snapshots: again, prevStates: prev, notifier });
            expect(calls).toHaveLength(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("readWorkflowSnapshots activity detection", () => {
    it("uses newest contained-file mtime, not the stale dir mtime (append-only writes)", async () => {
        const root = mkdtempSync(join(tmpdir(), "agent-watch-wf-"));

        try {
            const leaf = join(root, "proj", "sess", "subagents", "workflows", "wf-1");
            mkdirSync(leaf, { recursive: true });
            const transcript = join(leaf, "agent-1.jsonl");
            writeFileSync(transcript, "{}\n");

            // Age the DIRECTORY far past the stall timeout; keep the FILE fresh.
            const oldSec = (T0 - 10_000_000) / 1000;
            utimesSync(leaf, oldSec, oldSec);
            utimesSync(transcript, T0 / 1000, T0 / 1000);

            const snaps = await readWorkflowSnapshots({ root, now: T0 + 1_000, stallTimeoutMs: 120_000 });
            expect(snaps[0]?.state).toBe("RUNNING");
            expect(snaps[0]?.lastOutputAt).toBe(T0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
