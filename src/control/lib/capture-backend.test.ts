import { describe, expect, it } from "bun:test";
import { invalidBackend, type Plan } from "./capture-plan";
import { captureToolCommand } from "./capture-runner";

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
