import { describe, expect, test } from "bun:test";
import { PROFILE_VERSION, type Profile } from "@app/cmux/lib/types";
import { START_MS_TOLERANCE } from "@genesiscz/utils/process-identity";
import { collectReplayEntries, isAlive, killApp, mayReplayIntoSurface, type RescueSystem } from "./rescue";

/**
 * Records every signal, every simulated sleep AND stays controllable, so the
 * escalation and the grace window it waits through are both observable without
 * a real pid.
 */
function fakeSystem(opts: { diesAfterSignals?: number; isCmux?: () => boolean; startMs?: () => number | null } = {}) {
    const signals: Array<number | string> = [];
    const sleeps: number[] = [];
    /** Sleeps that had already elapsed when the first SIGKILL was delivered. */
    let sleepsBeforeKill = -1;
    let alive = true;
    let delivered = 0;

    const sys: RescueSystem = {
        kill: (_pid, signal) => {
            if (signal === 0) {
                if (!alive) {
                    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
                }

                return;
            }

            if (signal === "SIGKILL" && sleepsBeforeKill === -1) {
                sleepsBeforeKill = sleeps.length;
            }

            signals.push(signal);
            delivered += 1;

            if (opts.diesAfterSignals !== undefined && delivered >= opts.diesAfterSignals) {
                alive = false;
            }
        },
        sleep: async (ms) => {
            sleeps.push(ms);
        },
        isCmux: opts.isCmux ?? (() => true),
        startMs: opts.startMs ?? (() => 1_000_000),
    };

    return { sys, signals, sleeps, isAlive: () => alive, sleepsBeforeKill: () => sleepsBeforeKill };
}

describe("killApp", () => {
    test("SIGTERM alone when the app exits during the grace window", async () => {
        const fake = fakeSystem({ diesAfterSignals: 1 });

        const outcome = await killApp(4242, { sys: fake.sys, graceMs: 5000 });

        expect(outcome.signals).toEqual(["SIGTERM"]);
        expect(outcome.exited).toBe(true);
        expect(fake.signals).not.toContain("SIGKILL");
    });

    test("escalates to SIGKILL only after the whole grace window has elapsed", async () => {
        const fake = fakeSystem({ diesAfterSignals: 2 });

        const outcome = await killApp(4242, { sys: fake.sys, graceMs: 5000 });

        expect(outcome.signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(outcome.exited).toBe(true);
        // Asserting the signal ORDER alone would also pass for an implementation
        // that sent SIGKILL immediately, which is the 5 s safety the docstring
        // promises. So: ten 500 ms slices waited through before SIGKILL landed.
        expect(fake.sleepsBeforeKill()).toBe(10);
        expect(fake.sleeps.slice(0, 10)).toEqual(Array(10).fill(500));
    });

    test("a refused SIGTERM is reported, not thrown", async () => {
        const sys: RescueSystem = {
            kill: (_pid, signal) => {
                if (signal === "SIGTERM") {
                    throw Object.assign(new Error("EPERM"), { code: "EPERM" });
                }
            },
            sleep: async () => {},
            isCmux: () => true,
            startMs: () => 1_000_000,
        };

        const outcome = await killApp(4242, { sys, graceMs: 500 });

        expect(outcome.signals).toEqual(["SIGKILL"]);
    });

    test("a pid that no longer identifies as cmux is never signalled", async () => {
        const fake = fakeSystem({ isCmux: () => false });

        const outcome = await killApp(4242, { sys: fake.sys, graceMs: 5000 });

        expect(outcome.signals).toEqual([]);
        expect(fake.signals).toEqual([]);
        expect(outcome.exited).toBe(true);
    });

    test("a pid recycled DURING the grace window is not escalated to SIGKILL", async () => {
        // The window that matters: SIGTERM lands on cmux, cmux dies, the kernel
        // reissues the number, and the liveness probe now answers about a
        // stranger. Without the identity re-check that stranger gets SIGKILLed.
        let cmux = true;
        const fake = fakeSystem({ isCmux: () => cmux });
        const outcome = await killApp(4242, {
            sys: fake.sys,
            graceMs: 5000,
            onStep: (message) => {
                if (message.startsWith("Sending SIGTERM")) {
                    cmux = false;
                }
            },
        });

        expect(outcome.signals).toEqual(["SIGTERM"]);
        expect(fake.signals).not.toContain("SIGKILL");
    });

    test("a SECOND cmux on the reissued pid is not escalated to SIGKILL", async () => {
        // The case the command-line check cannot see: the user relaunches cmux
        // during the grace window and the kernel hands the new app the old pid.
        // Both processes match the binary suffix, so only the start time differs.
        let startMs = 1_000_000;
        const fake = fakeSystem({ startMs: () => startMs });
        const outcome = await killApp(4242, {
            sys: fake.sys,
            graceMs: 5000,
            onStep: (message) => {
                if (message.startsWith("Sending SIGTERM")) {
                    startMs = 1_000_000 + START_MS_TOLERANCE + 1;
                }
            },
        });

        expect(outcome.signals).toEqual(["SIGTERM"]);
        expect(fake.signals).not.toContain("SIGKILL");
    });

    test("a start time that drifts inside the ps rounding tolerance is still the same app", async () => {
        // `ps -o etime=` has one-second granularity, so two readings of one live
        // process differ. Treating that jitter as a recycled pid would refuse
        // every real rescue.
        let startMs = 1_000_000;
        const fake = fakeSystem({ diesAfterSignals: 2, startMs: () => startMs });
        const outcome = await killApp(4242, {
            sys: fake.sys,
            graceMs: 5000,
            onStep: (message) => {
                if (message.startsWith("Sending SIGTERM")) {
                    startMs = 1_000_000 + START_MS_TOLERANCE - 1;
                }
            },
        });

        expect(outcome.signals).toEqual(["SIGTERM", "SIGKILL"]);
    });

    test("a pid unreadable at baseline falls back to the command match alone", async () => {
        // Without a baseline there is nothing to compare against, and refusing
        // there would break the rescue on exactly the machines that need it.
        const fake = fakeSystem({ diesAfterSignals: 2, startMs: () => null });

        const outcome = await killApp(4242, { sys: fake.sys, graceMs: 5000 });

        expect(outcome.signals).toEqual(["SIGTERM", "SIGKILL"]);
    });

    test("a pid recycled after SIGKILL reports exited, not a surviving cmux", async () => {
        // rescue.ts treats `exited: false` as fatal and refuses to relaunch. A
        // stranger answering the final liveness probe would abort a rescue that
        // actually killed cmux.
        let cmux = true;
        const fake = fakeSystem({ isCmux: () => cmux });
        const outcome = await killApp(4242, {
            sys: fake.sys,
            graceMs: 500,
            onStep: (message) => {
                if (message.startsWith("Still alive")) {
                    cmux = false;
                }
            },
        });

        // The fake never dies, so isAlive() still says "something is there".
        expect(fake.isAlive()).toBe(true);
        expect(outcome.signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(outcome.exited).toBe(true);
    });
});

describe("isAlive", () => {
    const base = { sleep: async () => {}, isCmux: () => true, startMs: () => 1_000_000 };

    test("signal 0 succeeding means alive; ESRCH means gone", () => {
        expect(isAlive(1, { ...base, kill: () => {} })).toBe(true);
        expect(
            isAlive(1, {
                ...base,
                kill: () => {
                    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
                },
            })
        ).toBe(false);
    });

    test("EPERM means the process EXISTS but is not ours to signal — alive", () => {
        // Collapsing EPERM into "dead" made killApp report exited: true while
        // cmux was still running, and rescue then relaunched and replayed into
        // the live app.
        expect(
            isAlive(1, {
                ...base,
                kill: () => {
                    throw Object.assign(new Error("EPERM"), { code: "EPERM" });
                },
            })
        ).toBe(true);
    });

    test("an unexpected probe failure is treated as alive, not as gone", () => {
        expect(
            isAlive(1, {
                ...base,
                kill: () => {
                    throw new Error("something else entirely");
                },
            })
        ).toBe(true);
    });
});

describe("mayReplayIntoSurface", () => {
    test("a real title mismatch refuses the surface", () => {
        // Positional replay into a renamed surface types a captured command into
        // a different terminal than the reviewed plan showed.
        expect(mayReplayIntoSurface({ title: "bun test" }, { title: "vim" })).toBe(false);
        expect(mayReplayIntoSurface({ title: "bun test" }, { title: "bun test" })).toBe(true);
    });

    test("an unknown title on either side is not treated as a mismatch", () => {
        expect(mayReplayIntoSurface({ title: undefined }, { title: "vim" })).toBe(true);
        expect(mayReplayIntoSurface({ title: "bun test" }, { title: undefined })).toBe(true);
    });
});

describe("collectReplayEntries", () => {
    test("flattens windows → workspaces → panes → surfaces, keeping terminal commands only", () => {
        // Typed, not `as never`: the cast would hide a Profile field rename.
        const pane = {
            ref: "pane:1",
            index: 0,
            columns: 80,
            rows: 24,
            pixel_frame: { x: 0, y: 0, width: 800, height: 600 },
            selected_surface_index: 0,
            surfaces: [
                { title: "zsh", type: "terminal" as const, command: "bun run test" },
                { title: "docs", type: "browser" as const },
            ],
        };
        const profile: Profile = {
            version: PROFILE_VERSION,
            name: "rescue",
            scope: "all",
            captured_at: "2026-08-27T12:00:00.000Z",
            cmux_version: "test",
            windows: [
                {
                    ref: "window:1",
                    title: "main",
                    container_frame: { width: 1920, height: 1080 },
                    workspaces: [{ ref: "workspace:1", title: "GenesisTools", selected: true, panes: [pane] }],
                },
            ],
        };

        const entries = collectReplayEntries(profile);

        expect(entries).toHaveLength(2);
        expect(entries[0]).toMatchObject({ workspaceIndex: 0, tabIndex: 0, command: "bun run test" });
        expect(entries[1].command).toBeUndefined();
    });
});
