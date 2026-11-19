import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
    appendFileSync,
    closeSync,
    fsyncSync,
    mkdtempSync,
    openSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { join } from "node:path";
import { withSpawnCounter } from "@app/benchmark/lib";
import { fakeDriver } from "@genesiscz/utils/fs/watch-driver/fake";
import { startGenesisToolsService } from "@genesiscz/utils/genesis-tools/service/host";
import { createWorktreeService } from "@genesiscz/utils/genesis-tools/worktree/service";
import { TestRepo } from "@genesiscz/utils/git/test-repo";
import { SafeJSON } from "@genesiscz/utils/json";
import type { MetricsRecorder } from "@genesiscz/utils/metrics";
import { DEFAULT_HOOKS_CONFIG, HOOK_CONFIG_SECTIONS } from "../../config";
import { statusOf } from "../../git";
import { callDir } from "../../paths";
import { applySetting } from "../../set-config";
import { gitMode } from "./git";
import { armsFor, STATUS_MODES } from "./modes";
import { narrowGitMode } from "./narrow-git";
import { gitReads, prepareStatus, statusEligible } from "./prepare";
import { compareToReference, PARITY_CLASSES } from "./shadow";
import { snapshotArm } from "./snapshot";
import { type StatusArm, unbuiltArm } from "./types";

/** A fake shadow arm that drops the first entry of the Git view. */
const dropFirst: StatusArm = {
    id: "drop-first",
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
                config.shadow.modes = ["narrow-git"];
            }),
            recorder,
            arms: {
                active: gitMode.primary({}),
                reference: gitMode.primary({}),
                shadow: [dropFirst, unbuiltArm("snapshot:watchman", "snapshot")],
            },
        });
        expect(reads.read(repo.dir).entries).toEqual(statusOf(repo.dir).entries);
        const cpu = recorder.events.filter((event) => event.metric === "hook.status.cpu_ms");
        expect(cpu.map((event) => [event.dims.arm, event.dims.role, event.dims.outcome, event.dims.parity])).toEqual([
            ["git", "reference", "answered", "none"],
            ["drop-first", "shadow", "answered", "missing-dirty"],
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
            arms: { active: gitMode.primary({}), reference: gitMode.primary({}), shadow: [dropFirst] },
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

describe("the narrow-git mode", () => {
    let repo: TestRepo;

    beforeAll(async () => {
        repo = await TestRepo.create({ prefix: "hook-status-narrow-" });
        await repo.commitMany({ files: { "a.txt": "a\n", "b.txt": "b\n", "held.txt": "held\n" }, message: "base" });
        appendFileSync(join(repo.dir, "a.txt"), "edit\n");
    });

    afterAll(() => {
        repo.cleanup();
    });

    const request = (root: string, phase: "pre" | "post" = "pre") => ({
        phase,
        root,
        need: "all" as const,
        head: null,
        mark: null,
    });

    it("admits once, then answers from the narrow reads with no git status, and a git add admits again", async () => {
        const arm = narrowGitMode.primary({});
        const first = await arm.observe(request(repo.dir));
        expect(first.state === "ok" && first.source).toBe("admission");
        expect(first.state === "ok" && first.view.entries).toEqual(statusOf(repo.dir).entries);

        const counted = await withSpawnCounter(() => arm.observe(request(repo.dir)));
        expect(counted.result.state === "ok" && counted.result.source).toBe("narrow");
        expect(counted.spawns.length).toBe(2);
        expect(counted.spawns.some((spawn) => spawn.cmd.includes("status"))).toBe(false);
        expect(counted.result.state === "ok" && counted.result.view.entries.map((entry) => entry.path)).toEqual([
            "a.txt",
        ]);

        await repo.git(["add", "a.txt"]);
        const staged = await arm.observe(request(repo.dir));
        expect(staged.state === "ok" && staged.source).toBe("admission");
        const refused = await arm.observe(request(repo.dir));
        expect(refused.state === "unavailable" && refused.reason).toBe("refused-staged");
        await repo.git(["reset", "-q", "a.txt"]);
    });

    it("a write to a clean tracked file that stays open is in the pre view", async () => {
        const arm = narrowGitMode.primary({});
        await arm.observe(request(repo.dir));
        const fd = openSync(join(repo.dir, "held.txt"), "a");

        try {
            writeSync(fd, "A\n");
            fsyncSync(fd);
            const pre = await arm.observe(request(repo.dir));
            writeSync(fd, "B\n");
            fsyncSync(fd);
            const post = await arm.observe(request(repo.dir, "post"));
            expect(pre.state === "ok" && pre.view.entries.map((entry) => entry.path)).toContain("held.txt");
            expect(post.state === "ok" && post.view.entries.map((entry) => entry.path)).toContain("held.txt");
        } finally {
            closeSync(fd);
        }
    });
});

describe("the snapshot mode", () => {
    let repo: TestRepo;
    let dir: string;
    let stop: () => Promise<void> = async () => {};
    const settings = {
        driver: "watchman" as const,
        shadowDrivers: ["parcel" as const],
        deadlineMs: 3_000,
        fenceMs: 500,
    };

    beforeAll(async () => {
        repo = await TestRepo.create({ prefix: "hook-status-snapshot-" });
        await repo.commitMany({ files: { "a.txt": "a\n" }, message: "base" });
        appendFileSync(join(repo.dir, "a.txt"), "edit\n");
        dir = realpathSync(mkdtempSync("/tmp/gtst-"));
        const started = await startGenesisToolsService({
            dir,
            idleMs: 60_000,
            worktree: createWorktreeService({ drivers: { watchman: fakeDriver(), parcel: fakeDriver() } }),
        });

        if (started.status !== "started") {
            throw new Error("the isolated service did not start");
        }

        stop = async () => {
            started.host.stop("test over");
            await started.host.stopped;
        };
    });

    afterAll(async () => {
        await stop();
        repo.cleanup();
        rmSync(dir, { recursive: true, force: true });
    });

    it("pre writes a mark per arm, post sends it, and a stopped service gives the Git view", async () => {
        const watchman = snapshotArm("watchman", settings, { serviceDir: dir });
        const parcel = snapshotArm("parcel", settings, { serviceDir: dir });
        const warm = { phase: "pre" as const, root: repo.dir, need: "all" as const, head: null, mark: null };

        for (const arm of [watchman, parcel]) {
            let answer = await arm.observe(warm);

            for (let tries = 0; tries < 50 && answer.state !== "ok"; tries++) {
                await Bun.sleep(100);
                answer = await arm.observe(warm);
            }

            expect(answer.state).toBe("ok");
        }

        const snapshotCall = { ...call, toolUseId: "toolu_snapshot_1" };
        const arms = { active: watchman, reference: gitMode.primary({}), shadow: [parcel] };
        const config = statusConfig((value) => {
            value.active.write = "snapshot";
        });
        const roots = [{ root: repo.dir, head: null }];
        const pre = await prepareStatus({ phase: "pre", roots, need: "all", call: snapshotCall, config, arms });
        expect(pre.read(repo.dir).entries).toEqual(statusOf(repo.dir).entries);
        const marksPath = join(callDir("claude", snapshotCall.sessionId, snapshotCall.toolUseId), "status-marks.json");
        const marks = SafeJSON.parse(readFileSync(marksPath, "utf8"), { strict: true });
        expect(marks.v).toBe(1);
        expect(marks.arms["snapshot:watchman"][0].startsWith("v1:watchman:")).toBe(true);

        const recorder = memoryRecorder();
        const post = await prepareStatus({
            phase: "post",
            roots,
            need: "all",
            call: snapshotCall,
            config,
            arms,
            recorder,
        });
        expect(post.read(repo.dir).entries).toEqual(statusOf(repo.dir).entries);
        // The active arm answered at post, so it had its mark from pre (without one it falls back with `no-mark`).
        const active = recorder.events.find(
            (event) => event.metric === "hook.status.cpu_ms" && event.dims.role === "active"
        );
        expect([active?.dims.outcome, active?.dims.parity]).toEqual(["answered", "same"]);

        await stop();
        stop = async () => {};
        const stopped = await watchman.observe({ ...warm, phase: "post" });
        expect(stopped.state === "unavailable" && stopped.reason).toBe("no-service");
        const fallback = await prepareStatus({ phase: "post", roots, need: "all", call: snapshotCall, config, arms });
        expect(fallback.read(repo.dir).entries).toEqual(statusOf(repo.dir).entries);
    });
});
