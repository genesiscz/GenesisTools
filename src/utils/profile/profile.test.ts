import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { setProfilingConfig } from "@genesiscz/utils/GenesisTools";
import {
    FLUSH_AFTER_RECORDS,
    flushProfilerFile,
    PROFILER_SCOPE_NAMES,
    profiler,
    reloadProfiler,
} from "@genesiscz/utils/profile";
import { realGenesisToolsRoot, rmTestPath } from "@genesiscz/utils/storage/real-home-guard";

function logsDir(): string {
    return join(env.tools.getHome(), ".genesis-tools", "logs");
}

function profilingLogBodies(): string {
    // Records are buffered and flushed in batches, so a reader has to drain
    // them first (PR #343 review t3).
    flushProfilerFile();
    const dir = logsDir();
    if (!existsSync(dir)) {
        return "";
    }

    return readdirSync(dir)
        .filter((name) => name.endsWith("-profiling.log"))
        .map((name) => readFileSync(join(dir, name), "utf8"))
        .join("");
}

function captureStderr(fn: () => void): string {
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return (orig as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;

    try {
        fn();
    } finally {
        process.stderr.write = orig;
    }

    return chunks.join("");
}

/** The artifacts these tests create: the daily log, and the --file override target. */
function clearProfilingArtifacts(): void {
    const dir = logsDir();

    if (existsSync(dir)) {
        for (const name of readdirSync(dir)) {
            if (name.endsWith("-profiling.log")) {
                rmTestPath(join(dir, name));
            }
        }
    }

    rmTestPath(join(env.tools.getHome(), "custom-profile.log"));
}

describe("profiler config gate", () => {
    beforeEach(async () => {
        env.testing.unset("PROFILE");
        env.testing.unset("PROFILE_TO_STDERR");
        env.testing.unset("PROFILE_TO_FILE");
        await setProfilingConfig({
            enabled: false,
            scopes: [],
            stderr: false,
            file: true,
            filePath: null,
            minDurationMs: 0,
            summaryOnExit: false,
            detail: "phases",
        });
        reloadProfiler();
        // Remove only what these tests write. The logs dir is shared: a bun
        // worker runs several files in ONE process against ONE sandbox home, so
        // deleting it wholesale took other suites' logs with it and made results
        // depend on file order (PR #343 review t11).
        clearProfilingArtifacts();
    });

    afterEach(() => {
        env.testing.unset("PROFILE");
        env.testing.unset("PROFILE_TO_STDERR");
        env.testing.unset("PROFILE_TO_FILE");
        reloadProfiler();
    });

    it("writes a duration line to the profiling log and not to stderr when config enables it", async () => {
        await setProfilingConfig({ enabled: true });
        reloadProfiler();

        const stderr = captureStderr(() => {
            profiler.scope("t").measure("work", () => 1);
        });

        expect(profilingLogBodies()).toContain("[profile:t] work");
        expect(stderr).not.toContain("[profile:t]");
    });

    it("PROFILE=1 enables profiling even when config.enabled is false", () => {
        env.testing.set("PROFILE", "1");
        reloadProfiler();

        profiler.scope("t").measure("env-on", () => 1);

        expect(profilingLogBodies()).toContain("[profile:t] env-on");
    });

    // Regression: PROFILE=* was treated as a scope named "*", so no timer fired
    // (DEBUG=* already means "everything").
    it("PROFILE=* enables every scope like PROFILE=1", () => {
        env.testing.set("PROFILE", "*");
        reloadProfiler();

        profiler.scope("claude-history").measure("star-on", () => 1);

        expect(profilingLogBodies()).toContain("[profile:claude-history] star-on");
    });

    it("PROFILE=0 forces profiling off even when config.enabled is true", async () => {
        await setProfilingConfig({ enabled: true });
        env.testing.set("PROFILE", "0");
        reloadProfiler();

        profiler.scope("t").measure("forced-off", () => 1);

        expect(profilingLogBodies()).not.toContain("forced-off");
    });

    it("PROFILE_TO_STDERR=1 prints the duration line on stderr", async () => {
        await setProfilingConfig({ enabled: true });
        env.testing.set("PROFILE_TO_STDERR", "1");
        reloadProfiler();

        const stderr = captureStderr(() => {
            profiler.scope("t").measure("loud", () => 1);
        });

        expect(stderr).toContain("[profile:t] loud");
    });

    it("skips duration lines shorter than minDurationMs but still records stats", async () => {
        await setProfilingConfig({ enabled: true, minDurationMs: 50 });
        reloadProfiler();

        const p = profiler.scope("t");
        p.measure("fast", () => 1);

        expect(profilingLogBodies()).not.toContain("[profile:t] fast");
        expect(p.entries().some((e) => e.label === "fast" && e.count === 1)).toBe(true);
    });

    it("restricts scopes when PROFILE lists names", () => {
        env.testing.set("PROFILE", "claude-history");
        reloadProfiler();

        profiler.scope("claude-history").measure("hit", () => 1);
        profiler.scope("du").measure("miss", () => 1);

        const body = profilingLogBodies();
        expect(body).toContain("[profile:claude-history] hit");
        expect(body).not.toContain("[profile:du] miss");
    });

    it("PROFILE_TO_FILE writes to the given path instead of the daily log", async () => {
        const custom = join(env.tools.getHome(), "custom-profile.log");
        await setProfilingConfig({ enabled: true });
        env.testing.set("PROFILE_TO_FILE", custom);
        reloadProfiler();

        profiler.scope("t").measure("custom-path", () => 1);
        flushProfilerFile();

        expect(readFileSync(custom, "utf8")).toContain("[profile:t] custom-path");
        expect(profilingLogBodies()).not.toContain("custom-path");
    });
});

describe("profiler file sink", () => {
    afterEach(() => {
        env.testing.unset("PROFILE_TO_FILE");
        reloadProfiler();
    });

    it("a write failure disables file output instead of breaking the measured call", async () => {
        // PR #343 review t16: the throw propagated out of the finally block that
        // stops the timer, and in measure() it replaced the original error.
        await setProfilingConfig({ enabled: true });
        // A path whose parent is a FILE, so mkdirSync cannot create it.
        const blocker = join(env.tools.getHome(), "blocker");
        writeFileSync(blocker, "x");
        env.testing.set("PROFILE_TO_FILE", join(blocker, "nested", "profile.log"));
        reloadProfiler();

        const stderr = captureStderr(() => {
            expect(profiler.scope("t").measure("survives", () => "value")).toBe("value");
            flushProfilerFile();
        });

        expect(stderr).toContain("file output disabled");

        // And the original error still wins over the sink failure.
        //
        // Two things have to be re-established first, or this asserts nothing
        // (PR #343 review t24). `fileWriteBroken` is latched by the flush above,
        // so appendFile would return before touching the sink; reloadProfiler()
        // clears it. And records are buffered now, so a lone measure() only
        // schedules a microtask flush — the failure would land AFTER the call
        // rather than inside the `finally` that this is about. Filling the
        // buffer to one below the threshold makes the throwing call's own record
        // trip the synchronous flush, which is the original bug's exact shape.
        reloadProfiler();

        const secondStderr = captureStderr(() => {
            for (let i = 0; i < FLUSH_AFTER_RECORDS - 1; i++) {
                profiler.scope("t").measure(`filler-${i}`, () => i);
            }

            expect(() =>
                profiler.scope("t").measure("throws", () => {
                    throw new Error("the real error");
                })
            ).toThrow("the real error");
        });

        // The sink really did fail during that call, rather than being skipped.
        expect(secondStderr).toContain("file output disabled");
    });
});

describe("buffered flushing", () => {
    afterEach(() => {
        env.testing.unset("PROFILE_TO_FILE");
        reloadProfiler();
    });

    it("does not drain once per await, which would be a sync append per event", async () => {
        // PR #343 review t2 round 12: the buffer was drained by queueMicrotask,
        // and async code yields to the microtask queue between timed operations
        // — so nearly every record got its own appendFileSync, reinstating the
        // per-event overhead the buffer exists to remove.
        const target = join(env.tools.getHome(), "buffered-profile.log");
        await setProfilingConfig({ enabled: true });
        env.testing.set("PROFILE_TO_FILE", target);
        reloadProfiler();

        for (let i = 0; i < 5; i++) {
            await profiler.scope("t").measureAsync(`async-${i}`, async () => i);
        }

        // Several awaits have elapsed. With a microtask flush the file would
        // already exist and hold most of these records.
        expect(existsSync(target)).toBe(false);

        flushProfilerFile();

        expect(existsSync(target)).toBe(true);
        const written = readFileSync(target, "utf8");
        for (let i = 0; i < 5; i++) {
            expect(written).toContain(`async-${i}`);
        }

        rmTestPath(target);
    });

    it("still drains synchronously at the size threshold", async () => {
        // The batching timer must not let the buffer grow without bound.
        const target = join(env.tools.getHome(), "threshold-profile.log");
        await setProfilingConfig({ enabled: true });
        env.testing.set("PROFILE_TO_FILE", target);
        reloadProfiler();

        for (let i = 0; i < FLUSH_AFTER_RECORDS; i++) {
            profiler.scope("t").measure(`sync-${i}`, () => i);
        }

        // No explicit flush: crossing FLUSH_AFTER_RECORDS writes on its own.
        expect(existsSync(target)).toBe(true);

        flushProfilerFile();
        rmTestPath(target);
    });
});

describe("the profiler's real-home write guard", () => {
    // PR #343 review t2 round 11. The profiler writes with raw mkdirSync /
    // appendFileSync, bypassing Storage and therefore assertTestSafePath. A test
    // that leaks GENESIS_TOOLS_HOME while profiling is on would land a queued
    // flush in the developer's REAL ~/.genesis-tools/logs.
    afterEach(() => {
        env.testing.unset("PROFILE_TO_FILE");
        reloadProfiler();
    });

    it("refuses to write a profiling log into the real store", async () => {
        const realTarget = join(realGenesisToolsRoot(), "logs", "__profiler_guard_probe__.log");
        await setProfilingConfig({ enabled: true });
        env.testing.set("PROFILE_TO_FILE", realTarget);
        reloadProfiler();

        const stderr = captureStderr(() => {
            profiler.scope("t").measure("guarded", () => "value");
            flushProfilerFile();
        });

        // The guard fired, named the real store, and nothing was written.
        expect(stderr).toContain("REAL ~/.genesis-tools");
        expect(existsSync(realTarget)).toBe(false);
    });

    it("NEGATIVE CONTROL: a sandbox path is still written normally", async () => {
        // Without this, a guard that rejected everything would pass the test
        // above while silently disabling file profiling for every real user.
        const sandboxTarget = join(env.tools.getHome(), "guard-control-profile.log");
        await setProfilingConfig({ enabled: true });
        env.testing.set("PROFILE_TO_FILE", sandboxTarget);
        reloadProfiler();

        profiler.scope("t").measure("allowed", () => "value");
        flushProfilerFile();

        expect(existsSync(sandboxTarget)).toBe(true);
        expect(readFileSync(sandboxTarget, "utf8")).toContain("allowed");
        rmTestPath(sandboxTarget);
    });
});

describe("reloadProfiler and retained scopes", () => {
    afterEach(() => {
        env.testing.unset("PROFILE_TO_FILE");
        reloadProfiler();
    });

    it("a scope captured before the reload follows the new gate", async () => {
        // PR #343 review t20: a module-level `const prof = profiler.scope(...)`
        // kept the old gate forever, so reload was internally inconsistent.
        await setProfilingConfig({ enabled: false });
        reloadProfiler();

        const retained = profiler.scope("t");
        expect(retained.enabled).toBe(false);

        await setProfilingConfig({ enabled: true });
        reloadProfiler();

        expect(retained.enabled).toBe(true);
        retained.measure("after-reload", () => 1);
        expect(profilingLogBodies()).toContain("[profile:t] after-reload");
    });
});

describe("clones profiler scope", () => {
    it("is a known scope name and records under PROFILE=clones", () => {
        expect(PROFILER_SCOPE_NAMES).toContain("clones");
        env.testing.set("PROFILE", "clones");
        reloadProfiler();

        profiler.scope("clones").measure("discover", () => 1);

        expect(profilingLogBodies()).toContain("[profile:clones] discover");
    });
});
