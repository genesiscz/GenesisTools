import { describe, expect, it } from "bun:test";
import { NativeCaptureControls } from "./capture-native";
import { invalidBackend, type Plan } from "./capture-plan";
import { captureToolCommand } from "./capture-runner";
import type { AxResult } from "./runner";

function plan(backend?: unknown): Plan {
    return { capture: { mode: "window", duration: 2, backend }, actions: [] } as unknown as Plan;
}

describe("invalidBackend", () => {
    it("accepts the two backends and an absent one", () => {
        expect(invalidBackend(plan())).toBeUndefined();
        expect(invalidBackend(plan("native"))).toBeUndefined();
        expect(invalidBackend(plan("peekaboo"))).toBeUndefined();
    });

    // Everything that is not exactly "native" selects Peekaboo downstream, so a typo would
    // silently pick the opposite backend from the one it names.
    it("rejects anything else, including a near miss", () => {
        expect(invalidBackend(plan("Native"))).toContain("capture.backend");
        expect(invalidBackend(plan("sc"))).toContain("capture.backend");
        expect(invalidBackend(plan(""))).toContain("capture.backend");
        expect(invalidBackend(plan(1))).toContain("capture.backend");
    });
});
describe("captureToolCommand", () => {
    // Peekaboo 4 reads a bare `--duration` as milliseconds, so the standalone probe carries the
    // same `peekabooDurationArg` suffix as the real capture call (PR #376 review round 3).
    it("names peekaboo's own subcommand and standalone probe", () => {
        expect(captureToolCommand("peekaboo")).toEqual({
            command: "peekaboo 'capture live'",
            standalone: "peekaboo capture live --mode screen --duration 2s --json",
        });
    });

    // The native backend falls back to Peekaboo by replacing the attempt while `backend` still
    // reads "native", so a diagnostic keyed on `backend` would send an operator to debug the
    // wrong binary. Keying on the attempt's own tool is what makes these two differ.
    it("names the native recorder and its capture arguments", () => {
        expect(captureToolCommand("ax-tool")).toEqual({
            command: "ax-tool capture",
            standalone: "ax-tool capture --mode screen --duration 2 --out /tmp/capture-probe",
        });
    });
});

function captureFixture() {
    const calls: string[][] = [];
    let launch = 123;
    let missing = false;
    let title = "Fixture";
    let duplicate = false;
    const snapshot = (id = 10) => ({
        ok: true,
        app: "Fixture",
        pid: 7,
        processLaunch: launch,
        scope: "window",
        snapshot: `s${calls.length}`,
        window: { id, title, x: 0, y: 0, width: 400, height: 300 },
        screenshot: {},
        elements: [
            { index: 0, depth: 0, role: "AXWindow", actions: ["AXRaise"], x: 0, y: 0, width: 400, height: 300 },
            { index: 1, depth: 1, role: "AXButton", AXIdentifier: "save", AXTitle: "Save", actions: ["AXPress"] },
        ],
    });
    const controls = new NativeCaptureControls(
        { mode: "window", app: "Fixture", duration: 5 },
        {
            native: {
                run: async ({ args }): Promise<AxResult> => {
                    calls.push(args);
                    if (args[0] === "window") {
                        return { ok: true, windows: duplicate ? [{ title }, { title }] : [{ title }] };
                    }

                    if (args[0] === "see") {
                        if (missing) {
                            return { ok: false, error: "bound window is closed" };
                        }

                        return snapshot(
                            args.includes("--window-index") ? 10 + Number(args[args.indexOf("--window-index") + 1]) : 10
                        );
                    }

                    return { ok: true, after: snapshot() };
                },
            },
        }
    );
    return {
        controls,
        calls,
        restart: () => {
            launch++;
        },
        close: () => {
            missing = true;
        },
        retitle: () => {
            title = "Renamed";
        },
        duplicate: () => {
            duplicate = true;
        },
    };
}

describe("native capture target binding", () => {
    it("uses fresh observations and actions for a 20-action fixed-window recording", async () => {
        const f = captureFixture();
        for (let step = 0; step < 20; step++) {
            expect((await f.controls.run({ do: "ax-press", axId: "save", app: "Fixture", atMs: 0 })).ok).toBe(true);
        }
        expect(f.calls.filter((args) => args[0] === "window")).toHaveLength(1);
        expect(f.calls.filter((args) => args[0] === "see")).toHaveLength(20);
        expect(f.calls.filter((args) => args[0] === "act")).toHaveLength(20);
        f.controls.dispose();
    });

    it("a bound recording ignores window order/title changes but refuses a closed window or restarted app", async () => {
        for (const change of ["retitle", "duplicate", "close", "restart"] as const) {
            const f = captureFixture();
            expect((await f.controls.run({ do: "ax-press", axId: "save", app: "Fixture", atMs: 0 })).ok).toBe(true);
            f[change]();
            const result = await f.controls.run({ do: "ax-press", axId: "save", app: "Fixture", atMs: 0 });
            const refused = change === "close" || change === "restart";
            expect(result.ok).toBe(!refused);
            expect(f.calls.filter((args) => args[0] === "window")).toHaveLength(1);
            expect(f.calls.filter((args) => args[0] === "act")).toHaveLength(refused ? 1 : 2);
            expect(f.calls.filter((args) => args[0] === "see").at(-1)).toContain("--window-id");
            f.controls.dispose();
        }
    });

    it("focus-stop and explicit focus force a fresh target resolution", async () => {
        const f = captureFixture();
        await f.controls.run({ do: "ax-press", axId: "save", app: "Fixture", atMs: 0 });
        await f.controls.run({ do: "focus-stop", atMs: 0 });
        await f.controls.run({ do: "ax-press", axId: "save", app: "Fixture", atMs: 0 });
        await f.controls.focus({ app: "Fixture" });
        expect(f.calls.filter((args) => args[0] === "window")).toHaveLength(3);
        f.controls.dispose();
    });

    it("ambiguous AX matches across windows never bind or dispatch", async () => {
        const f = captureFixture();
        f.duplicate();
        expect((await f.controls.run({ do: "ax-press", axId: "save", app: "Fixture", atMs: 0 })).ok).toBe(false);
        expect(f.calls.filter((args) => args[0] === "act")).toHaveLength(0);
        f.controls.dispose();
    });
});
