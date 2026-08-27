import { describe, expect, test } from "bun:test";
import { PROFILE_VERSION, type Profile } from "@app/cmux/lib/types";
import { collectReplayEntries, isAlive, killApp, mayReplayIntoSurface, type RescueSystem } from "./rescue";

/** Records every signal AND stays controllable, so escalation is observable without a real pid. */
function fakeSystem(opts: { diesAfterSignals?: number } = {}) {
    const signals: Array<number | string> = [];
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

            signals.push(signal);
            delivered += 1;

            if (opts.diesAfterSignals !== undefined && delivered >= opts.diesAfterSignals) {
                alive = false;
            }
        },
        sleep: async () => {},
    };

    return { sys, signals, isAlive: () => alive };
}

describe("killApp", () => {
    test("SIGTERM alone when the app exits during the grace window", async () => {
        const fake = fakeSystem({ diesAfterSignals: 1 });

        const outcome = await killApp(4242, { sys: fake.sys, graceMs: 5000 });

        expect(outcome.signals).toEqual(["SIGTERM"]);
        expect(outcome.exited).toBe(true);
        expect(fake.signals).not.toContain("SIGKILL");
    });

    test("escalates to SIGKILL only after the grace window", async () => {
        const fake = fakeSystem({ diesAfterSignals: 2 });

        const outcome = await killApp(4242, { sys: fake.sys, graceMs: 5000 });

        expect(outcome.signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(outcome.exited).toBe(true);
    });

    test("a refused SIGTERM is reported, not thrown", async () => {
        const sys: RescueSystem = {
            kill: (_pid, signal) => {
                if (signal === "SIGTERM") {
                    throw Object.assign(new Error("EPERM"), { code: "EPERM" });
                }
            },
            sleep: async () => {},
        };

        const outcome = await killApp(4242, { sys, graceMs: 500 });

        expect(outcome.signals).toEqual(["SIGKILL"]);
    });
});

describe("isAlive", () => {
    test("signal 0 succeeding means alive; ESRCH means gone", () => {
        expect(isAlive(1, { kill: () => {}, sleep: async () => {} })).toBe(true);
        expect(
            isAlive(1, {
                kill: () => {
                    throw new Error("ESRCH");
                },
                sleep: async () => {},
            })
        ).toBe(false);
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
