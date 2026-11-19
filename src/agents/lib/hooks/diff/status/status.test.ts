import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestRepo } from "@genesiscz/utils/git/test-repo";
import type { MetricsRecorder } from "@genesiscz/utils/metrics";
import { DEFAULT_HOOKS_CONFIG, HOOK_CONFIG_SECTIONS } from "../../config";
import { statusOf } from "../../git";
import { applySetting } from "../../set-config";
import type { StatusArm, StatusModeModule, StatusModeSettings } from "./types";

/** The narrow-git module is replaced by a fake whose arm drops the first dirty entry of the Git view. */
const dropFirst: StatusArm = {
    id: "narrow-git",
    mode: "narrow-git",
    async observe(request) {
        const summary = statusOf(request.root);
        return {
            state: "ok",
            view: { head: summary.branch?.oid ?? null, entries: summary.entries.slice(1) },
            mark: null,
            source: "fake",
            cost: { cpuMs: 1, wallMs: 1, gitSpawns: 1, serviceCpuMs: null, fullStatus: true },
        };
    },
};
const fakeNarrow: StatusModeModule<StatusModeSettings["narrow-git"]> = { primary: () => dropFirst, variants: () => [] };
mock.module("./narrow-git", () => ({ narrowGitMode: fakeNarrow }));

const { prepareStatus, gitReads, statusEligible } = await import("./prepare");
const { compareToReference, PARITY_CLASSES } = await import("./shadow");
const { armsFor, STATUS_MODES } = await import("./modes");

interface Recorded {
    metric: string;
    value: number;
    dims: Record<string, unknown>;
}

function memoryRecorder(): MetricsRecorder & { events: Recorded[] } {
    const events: Recorded[] = [];
    return {
        events,
        record: (_project, metric, value, dims) => {
            events.push({ metric, value, dims: dims ?? {} });
        },
        flush: () => {},
    };
}

function statusConfig(patch: (config: typeof DEFAULT_HOOKS_CONFIG.diff.status) => void) {
    const config = structuredClone(DEFAULT_HOOKS_CONFIG.diff.status);
    patch(config);
    return config;
}

const call = {
    harness: "claude" as const,
    sessionId: `status-test-${process.pid}`,
    toolUseId: "toolu_status_1",
    command: "echo hi > out.txt",
    dir: null,
};

describe("diff.status config", () => {
    it("an absent key loads the defaults, a partial one merges field by field, a wrong id is a problem", () => {
        expect(DEFAULT_HOOKS_CONFIG.diff.status).toEqual({
            active: { read: "git", write: "git" },
            shadow: { modes: [], every: 1, budgetMs: 400 },
            modes: {
                git: {},
                snapshot: { driver: "watchman", shadowDrivers: [], deadlineMs: 700, fenceMs: 500 },
                "narrow-git": {},
            },
        });
        const problems: string[] = [];
        const merged = HOOK_CONFIG_SECTIONS.diff.merge(
            { status: { active: { read: "narrow-git", write: "fsmonitor" }, modes: { snapshot: { fenceMs: 250 } } } },
            problems
        );
        expect(merged.status.active).toEqual({ read: "narrow-git", write: "git" });
        expect(merged.status.modes.snapshot).toEqual({
            driver: "watchman",
            shadowDrivers: [],
            deadlineMs: 700,
            fenceMs: 250,
        });
        expect(problems).toEqual(['diff.status.active.write: unknown id "fsmonitor", using git']);
    });

    it("set takes the nested keys and comma lists, and refuses an unknown id", () => {
        let config = applySetting(DEFAULT_HOOKS_CONFIG, "diff.status.shadow.modes", "snapshot,narrow-git");
        config = applySetting(config, "diff.status.modes.snapshot.shadowDrivers", "parcel");
        expect(config.diff.status.shadow.modes).toEqual(["snapshot", "narrow-git"]);
        expect(config.diff.status.modes.snapshot.shadowDrivers).toEqual(["parcel"]);
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "diff.status.active.read", "fsmonitor")).toThrow();
    });
});

describe("the status seam", () => {
    let repo: TestRepo;

    beforeAll(async () => {
        repo = await TestRepo.create({ prefix: "hook-status-modes-" });
        await repo.commitMany({ files: { "a.txt": "a\n", "b.txt": "b\n" }, message: "base" });
        appendFileSync(join(repo.dir, "a.txt"), "edit\n");
        writeFileSync(join(repo.dir, "new.txt"), "new\n");
    });

    afterAll(() => {
        repo.cleanup();
    });

    it("the default config returns the Git reads at once: no arm, no mode load, no recorder", async () => {
        const recorder = memoryRecorder();
        const reads = await prepareStatus({
            phase: "pre",
            roots: [{ root: repo.dir, head: null }],
            need: "all",
            call,
            config: DEFAULT_HOOKS_CONFIG.diff.status,
            recorder,
        });
        expect(recorder.events).toEqual([]);
        expect(reads.read(repo.dir).entries).toEqual(statusOf(repo.dir).entries);
        expect(gitReads("deletions").read(repo.dir).entries).toEqual(statusOf(repo.dir, { trackedOnly: true }).entries);
    });

    it("an active arm that answers unavailable gives the Git view", async () => {
        const reads = await prepareStatus({
            phase: "pre",
            roots: [{ root: repo.dir, head: null }],
            need: "all",
            call,
            config: statusConfig((config) => {
                config.active.write = "snapshot";
            }),
        });
        expect(reads.read(repo.dir).entries).toEqual(statusOf(repo.dir).entries);
    });

    it("a shadow arm that lacks one dirty entry is recorded as missing-dirty and changes nothing in the view", async () => {
        const recorder = memoryRecorder();
        const reads = await prepareStatus({
            phase: "pre",
            roots: [{ root: repo.dir, head: null }],
            need: "all",
            call,
            config: statusConfig((config) => {
                config.shadow.modes = ["narrow-git", "snapshot"];
            }),
            recorder,
        });
        expect(reads.read(repo.dir).entries).toEqual(statusOf(repo.dir).entries);
        const cpu = recorder.events.filter((event) => event.metric === "hook.status.cpu_ms");
        expect(cpu.map((event) => [event.dims.arm, event.dims.role, event.dims.outcome, event.dims.parity])).toEqual([
            ["git", "reference", "answered", "none"],
            ["narrow-git", "shadow", "answered", "missing-dirty"],
            ["snapshot:watchman", "shadow", "fallback", "none"],
        ]);
    });

    it("a shadow arm past the budget is skipped", async () => {
        const recorder = memoryRecorder();
        await prepareStatus({
            phase: "pre",
            roots: [{ root: repo.dir, head: null }],
            need: "all",
            call,
            config: statusConfig((config) => {
                config.shadow.modes = ["narrow-git"];
                config.shadow.budgetMs = 0;
            }),
            recorder,
        });
        const shadow = recorder.events.find((event) => event.dims.role === "shadow");
        expect(shadow?.dims.outcome).toBe("skipped");
        expect(shadow?.dims.reason).toBe("budget");
    });

    it("armsFor turns config into arms through the table only", async () => {
        const arms = await armsFor(
            statusConfig((config) => {
                config.active.read = "snapshot";
                config.shadow.modes = ["snapshot", "git"];
                config.modes.snapshot.shadowDrivers = ["parcel"];
            }),
            "read"
        );
        expect(arms.active.id).toBe("snapshot:watchman");
        expect(arms.reference.id).toBe("git");
        expect(arms.shadow.map((arm) => arm.id)).toEqual(["snapshot:parcel"]);
        expect(Object.keys(STATUS_MODES)).toEqual(["git", "snapshot", "narrow-git"]);
    });
});

describe("parity and eligibility", () => {
    const entry = (path: string, worktree: string) => ({ kind: "changed" as const, path, index: ".", worktree });

    it("classifies differences against the reference", () => {
        const reference = { head: "a", entries: [entry("x", "M"), entry("y", "D")] };
        expect(compareToReference({ need: "all", phase: "pre", reference, got: reference }).parity).toBe("same");
        expect(
            compareToReference({ need: "all", phase: "pre", reference, got: { head: "a", entries: [entry("y", "D")] } })
                .parity
        ).toBe("missing-dirty");
        expect(
            compareToReference({
                need: "deletions",
                phase: "pre",
                reference,
                got: { head: "a", entries: [entry("y", "D")] },
            }).parity
        ).toBe("same");
        expect(
            compareToReference({
                need: "all",
                phase: "pre",
                reference,
                got: { head: "a", entries: [entry("y", "D"), entry("x", "M")] },
            }).parity
        ).toBe("order");
        expect(PARITY_CLASSES).toContain("unconfirmed");
    });

    it("a background job, a detached writer and a test process use Git only", () => {
        expect(statusEligible({ ...call, command: "sleep 5 &" }, { background: false, deferred: false })).toBe(false);
        expect(statusEligible({ ...call, command: "nohup make" }, { background: false, deferred: false })).toBe(false);
        expect(statusEligible(call, { background: true, deferred: false })).toBe(false);
        expect(statusEligible({ ...call, command: "a && b" }, { background: false, deferred: false })).toBe(false);
    });
});
