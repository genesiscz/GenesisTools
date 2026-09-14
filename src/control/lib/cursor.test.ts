import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import {
    type ClickSoftwareCursorOptions,
    type CursorDependencies,
    clickSoftwareCursor,
    cursorPath,
    loadCursor,
    type MoveSoftwareCursorOptions,
    moveSoftwareCursor,
    saveCursor,
} from "./cursor";

let testHome = "";
type MoveOptions = Omit<MoveSoftwareCursorOptions, "dependencies">;
type ClickOptions = Omit<ClickSoftwareCursorOptions, "dependencies">;

function invokeMove(options: MoveOptions, dependencies: CursorDependencies) {
    return moveSoftwareCursor({ ...options, dependencies });
}

function invokeClick(options: ClickOptions, dependencies: CursorDependencies) {
    return clickSoftwareCursor({ ...options, dependencies });
}

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");

    if (testHome && existsSync(testHome)) {
        rmSync(testHome, { recursive: true, force: true });
    }

    testHome = "";
});

test("a successful move persists its window addressed software cursor", () => {
    testHome = mkdtempSync(join(tmpdir(), "control-cursor-"));
    env.testing.set("GENESIS_TOOLS_HOME", testHome);
    const snapshot = Buffer.from(
        '{"version":1,"pid":4321,"launch":12.5,"window":987,"depth":20,"digest":"tree","created":100}'
    ).toString("base64");
    const calls: string[][] = [];

    const result = invokeMove(
        { app: "Fixture App", snapshot, coords: "120.5,-30", name: "toolbar" },
        {
            now: () => new Date("2026-09-08T10:00:00.000Z"),
            runAx: (args) => {
                calls.push(args);
                return { ok: true, action: "move", pid: 4321, windowId: 987, refreshRequired: true };
            },
        }
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
        [
            "act",
            "--app",
            "Fixture App",
            "--snapshot",
            snapshot,
            "--action",
            "move",
            "--coords",
            "120.5,-30",
            "--background",
        ],
    ]);
    expect(loadCursor("toolbar")).toEqual({
        name: "toolbar",
        pid: 4321,
        windowId: 987,
        x: 120.5,
        y: -30,
        snapshot,
        movedAt: "2026-09-08T10:00:00.000Z",
    });
});

test("a fresh token for another window is rejected before click dispatch", () => {
    testHome = mkdtempSync(join(tmpdir(), "control-cursor-"));
    env.testing.set("GENESIS_TOOLS_HOME", testHome);
    const savedSnapshot = Buffer.from(
        '{"version":1,"pid":4321,"launch":12.5,"window":987,"depth":20,"digest":"tree","created":100}'
    ).toString("base64");
    const wrongWindowSnapshot = Buffer.from(
        '{"version":1,"pid":4321,"launch":12.5,"window":654,"depth":20,"digest":"tree","created":101}'
    ).toString("base64");
    saveCursor({
        name: "toolbar",
        pid: 4321,
        windowId: 987,
        x: 120.5,
        y: -30,
        snapshot: savedSnapshot,
        movedAt: "2026-09-08T10:00:00.000Z",
    });
    const calls: string[][] = [];

    const result = invokeClick(
        { name: "toolbar", snapshot: wrongWindowSnapshot },
        {
            now: () => new Date("2026-09-08T10:01:00.000Z"),
            runAx: (args) => {
                calls.push(args);
                return { ok: true, action: "click", pid: 4321, windowId: 987, refreshRequired: true };
            },
        }
    );

    expect(result).toEqual({ ok: false, error: "snapshot belongs to a different window than cursor toolbar" });
    expect(calls).toEqual([]);
});

test("cursor paths stay under the control cursor directory", () => {
    testHome = mkdtempSync(join(tmpdir(), "control-cursor-"));
    env.testing.set("GENESIS_TOOLS_HOME", testHome);

    expect(cursorPath("toolbar")).toBe(join(testHome, ".genesis-tools", "control", "cursors", "toolbar.json"));
});

test("unsafe cursor names cannot escape the cursor directory", () => {
    testHome = mkdtempSync(join(tmpdir(), "control-cursor-"));
    env.testing.set("GENESIS_TOOLS_HOME", testHome);

    expect(() => cursorPath("../outside")).toThrow(
        "cursor name must use 1-64 ASCII letters, digits, underscores or hyphens"
    );
    expect(existsSync(join(testHome, ".genesis-tools", "control", "outside.json"))).toBe(false);
});

test("a failed move leaves the saved cursor unchanged", () => {
    testHome = mkdtempSync(join(tmpdir(), "control-cursor-"));
    env.testing.set("GENESIS_TOOLS_HOME", testHome);
    const saved = {
        name: "toolbar",
        pid: 4321,
        windowId: 987,
        x: 120.5,
        y: -30,
        snapshot: "saved-token",
        movedAt: "2026-09-08T10:00:00.000Z",
    };
    saveCursor(saved);

    const result = invokeMove(
        { app: "Fixture App", snapshot: "replacement-token", coords: "500,600", name: "toolbar" },
        {
            now: () => new Date("2026-09-08T10:05:00.000Z"),
            runAx: () => ({ ok: false, error: "UI changed; run see again" }),
        }
    );

    expect(result).toEqual({ ok: false, error: "UI changed; run see again" });
    expect(loadCursor("toolbar")).toEqual(saved);
});

test("click dispatches the saved token coordinates and app PID", () => {
    testHome = mkdtempSync(join(tmpdir(), "control-cursor-"));
    env.testing.set("GENESIS_TOOLS_HOME", testHome);
    const savedSnapshot = Buffer.from(
        '{"version":1,"pid":4321,"launch":12.5,"window":987,"depth":20,"digest":"tree","created":100,"scope":"chrome"}'
    ).toString("base64");
    saveCursor({
        name: "toolbar",
        pid: 4321,
        windowId: 987,
        x: 120.5,
        y: -30,
        snapshot: savedSnapshot,
        movedAt: "2026-09-08T10:00:00.000Z",
    });
    const calls: string[][] = [];

    const result = invokeClick(
        { name: "toolbar", button: "right", double: true },
        {
            now: () => new Date("2026-09-08T10:01:00.000Z"),
            runAx: (args) => {
                calls.push(args);
                return { ok: true, action: "click", pid: 4321, windowId: 987, refreshRequired: true };
            },
        }
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
        [
            "act",
            "--app",
            "4321",
            "--snapshot",
            savedSnapshot,
            "--action",
            "click",
            "--coords",
            "120.5,-30",
            "--background",
            "--button",
            "right",
            "--double",
        ],
    ]);
});

test("loading a missing cursor does not create storage", () => {
    testHome = mkdtempSync(join(tmpdir(), "control-cursor-"));
    env.testing.set("GENESIS_TOOLS_HOME", testHome);
    const controlDirectory = join(testHome, ".genesis-tools", "control");

    expect(loadCursor("toolbar")).toBeNull();
    expect(existsSync(controlDirectory)).toBe(false);
});

test("move refuses inconsistent native metadata instead of persisting", () => {
    testHome = mkdtempSync(join(tmpdir(), "control-cursor-"));
    env.testing.set("GENESIS_TOOLS_HOME", testHome);
    const snapshot = Buffer.from(
        '{"version":1,"pid":4321,"launch":12.5,"window":987,"depth":20,"digest":"tree","created":100,"scope":"chrome"}'
    ).toString("base64");

    const result = invokeMove(
        { app: "Fixture App", snapshot, coords: "120.5,-30", name: "toolbar" },
        {
            now: () => new Date("2026-09-08T10:00:00.000Z"),
            runAx: () => ({ ok: true, action: "move", pid: 9999, windowId: 987, refreshRequired: true }),
        }
    );

    expect(result).toEqual({ ok: false, error: "native move metadata does not match snapshot" });
    expect(loadCursor("toolbar")).toBeNull();
});

test("a fresh token for another app launch is rejected before click dispatch", () => {
    testHome = mkdtempSync(join(tmpdir(), "control-cursor-"));
    env.testing.set("GENESIS_TOOLS_HOME", testHome);
    const savedSnapshot = Buffer.from(
        '{"version":1,"pid":4321,"launch":12.5,"window":987,"depth":20,"digest":"tree","created":100}'
    ).toString("base64");
    const replacementLaunchSnapshot = Buffer.from(
        '{"version":1,"pid":4321,"launch":13.5,"window":987,"depth":20,"digest":"tree","created":101}'
    ).toString("base64");
    saveCursor({
        name: "toolbar",
        pid: 4321,
        windowId: 987,
        x: 120.5,
        y: -30,
        snapshot: savedSnapshot,
        movedAt: "2026-09-08T10:00:00.000Z",
    });
    const calls: string[][] = [];

    const result = invokeClick(
        { name: "toolbar", snapshot: replacementLaunchSnapshot },
        {
            now: () => new Date("2026-09-08T10:01:00.000Z"),
            runAx: (args) => {
                calls.push(args);
                return { ok: true, action: "click", pid: 4321, windowId: 987, refreshRequired: true };
            },
        }
    );

    expect(result).toEqual({ ok: false, error: "snapshot belongs to a different app launch than cursor toolbar" });
    expect(calls).toEqual([]);
});

test("click rejects saved token metadata inconsistent with cursor state before dispatch", () => {
    testHome = mkdtempSync(join(tmpdir(), "control-cursor-"));
    env.testing.set("GENESIS_TOOLS_HOME", testHome);
    const inconsistentSnapshot = Buffer.from(
        '{"version":1,"pid":1111,"launch":12.5,"window":987,"depth":20,"digest":"tree","created":100}'
    ).toString("base64");
    saveCursor({
        name: "toolbar",
        pid: 4321,
        windowId: 987,
        x: 120.5,
        y: -30,
        snapshot: inconsistentSnapshot,
        movedAt: "2026-09-08T10:00:00.000Z",
    });
    const calls: string[][] = [];

    const result = invokeClick(
        { name: "toolbar" },
        {
            now: () => new Date("2026-09-08T10:01:00.000Z"),
            runAx: (args) => {
                calls.push(args);
                return { ok: true, action: "click", pid: 4321, windowId: 987, refreshRequired: true };
            },
        }
    );

    expect(result).toEqual({ ok: false, error: "saved snapshot metadata does not match cursor toolbar" });
    expect(calls).toEqual([]);
});
