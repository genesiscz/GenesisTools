/**
 * The focus-steal guard on the legacy keyboard verbs (handoff h_00ddcbx1 t5). Measured 2026-09-09:
 * `type --to-pid` raised Genesis over cmux, and `hotkey` sent `cmd,b` into the user's terminal and
 * reported ok. These tests never read the real window server: the frontmost state is a fixture.
 */
import { describe, expect, test } from "bun:test";
import { appNameFromCommand, focusStealRefusal, frontStateFrom, guardApplies, guardFocusSteal } from "./focus-guard";

const cmuxFront = { pid: 501, app: "cmux" };

describe("focusStealRefusal", () => {
    test("type into an app that is not frontmost refuses, naming the frontmost app and the safe path", () => {
        const refusal = focusStealRefusal({ verb: "type", app: "Finder", front: cmuxFront });

        expect(refusal).toContain("the frontmost app, cmux (pid 501)");
        expect(refusal).toContain("the target is Finder");
        expect(refusal).toContain("No event was posted");
        expect(refusal).toContain("act");
        expect(refusal).toContain("--steal-focus");
    });

    test("set and hotkey refuse the same way, each with its own substitute", () => {
        expect(focusStealRefusal({ verb: "set", app: "Finder", front: cmuxFront })).toContain("--action set");
        expect(focusStealRefusal({ verb: "hotkey", app: "Finder", front: cmuxFront })).toContain("--action key");
    });

    test("a hotkey with no target refuses: its keys would land in the frontmost app", () => {
        const refusal = focusStealRefusal({ verb: "hotkey", front: cmuxFront });

        expect(refusal).toContain("has no target app, so its keys would land in the frontmost app, cmux");
    });

    test("an unreadable frontmost app refuses: a guard that fails open is no guard", () => {
        expect(focusStealRefusal({ verb: "type", app: "Finder", front: null })).toContain("could not be read");
    });

    describe("negative control: nothing is taken, so it runs", () => {
        test("the target app is already frontmost", () => {
            expect(focusStealRefusal({ verb: "type", app: "cmux", front: cmuxFront })).toBeNull();
        });

        test("--to-pid names the frontmost process", () => {
            expect(focusStealRefusal({ verb: "hotkey", toPid: "501", front: cmuxFront })).toBeNull();
        });
    });
});

describe("frontStateFrom", () => {
    test("names the frontmost pid through one of its on-screen windows", () => {
        const state = frontStateFrom({
            ok: true,
            frontmostPid: 501,
            windows: [
                { pid: 77, app: "Finder" },
                { pid: 501, app: "cmux", title: "work" },
            ],
        });

        expect(state).toEqual({ pid: 501, app: "cmux", topWindow: { app: "Finder" } });
    });

    test("a frontmost pid with no on-screen window keeps the pid only", () => {
        expect(frontStateFrom({ ok: true, frontmostPid: 9, windows: [] })).toEqual({ pid: 9 });
    });

    test("a failed read is null", () => {
        expect(frontStateFrom({ ok: false, error: "no AX" })).toBeNull();
    });
});

describe("guardApplies", () => {
    test("always is the default, and off lifts it", () => {
        expect(guardApplies(undefined, {})).toBe(true);
        expect(guardApplies("always", {})).toBe(true);
        expect(guardApplies("off", {})).toBe(false);
    });

    test("agents applies under an agent only", () => {
        expect(guardApplies("agents", { CLAUDECODE: "1" })).toBe(true);
        expect(guardApplies("agents", {})).toBe(false);
    });
});

describe("guardFocusSteal", () => {
    const throwingFront = () => {
        throw new Error("the frontmost read must not run");
    };

    test("refuses with a not_started result carrying the frontmost app", async () => {
        const result = await guardFocusSteal({
            verb: "type",
            app: "Finder",
            readFront: () => cmuxFront,
            loadGuard: async () => undefined,
            environment: {},
        });

        expect(result?.ok).toBe(false);
        expect(result?.refusal).toBe("focus_steal");
        expect(result?.dispatchState).toBe("not_started");
        expect(result?.frontmost).toEqual(cmuxFront);
    });

    test("--steal-focus leaves behaviour unchanged: no read, no refusal", async () => {
        const result = await guardFocusSteal({
            verb: "type",
            app: "Finder",
            stealFocus: true,
            readFront: throwingFront,
            loadGuard: async () => "always",
        });

        expect(result).toBeNull();
    });

    test("the saved setting off lifts it without reading the window server", async () => {
        const result = await guardFocusSteal({
            verb: "set",
            app: "Finder",
            readFront: throwingFront,
            loadGuard: async () => "off",
        });

        expect(result).toBeNull();
    });
});

describe("naming a frontmost process that has no window", () => {
    test("a bundle path reads as the app name, a bare executable as its basename", () => {
        expect(
            appNameFromCommand(
                "/System/Library/CoreServices/NotificationCenter.app/Contents/MacOS/NotificationCenter\n"
            )
        ).toBe("NotificationCenter");
        expect(appNameFromCommand("/usr/local/bin/helper")).toBe("helper");
    });

    test("ax-tool apps names the pid, and the top window is kept for the message", () => {
        const state = frontStateFrom(
            { ok: true, frontmostPid: 40, windows: [{ pid: 501, app: "cmux", title: "work" }] },
            { ok: true, apps: [{ pid: 40, name: "Panel Helper" }] }
        );

        expect(state).toEqual({ pid: 40, app: "Panel Helper", topWindow: { app: "cmux", title: "work" } });
        expect(focusStealRefusal({ verb: "type", app: "Finder", front: state })).toContain(
            'Panel Helper (pid 40) (top window: cmux "work")'
        );
    });
});
