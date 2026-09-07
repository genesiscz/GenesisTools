import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableScreenCollector, screenCollectorStatus } from "@app/cmux/lib/capture-collector-lifecycle";
import { installCapture, uninstallCapture } from "@app/cmux/lib/capture-installer";
import { SafeJSON } from "@genesiscz/utils/json";

test("default install owns one detached collector and uninstall stops it without deleting cache", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-collector-home-"));
    const root = join(home, ".genesis-tools/cmux");
    try {
        const installed = await installCapture({ home });
        expect(installed.screens).toMatchObject({ enabled: true, running: true, ownerMatches: true });
        const again = await installCapture({ home });
        expect(again.screens.pid).toBe(installed.screens.pid);
        expect(again.changed).toBe(false);
        writeFileSync(join(root, "cached-fixture.txt"), "retain");
    } finally {
        uninstallCapture({ home });
    }

    for (let attempt = 0; attempt < 60 && screenCollectorStatus(root).running; attempt++) {
        await Bun.sleep(25);
    }

    expect(screenCollectorStatus(root)).toMatchObject({ enabled: false, running: false });
    expect(readFileSync(join(root, "cached-fixture.txt"), "utf8")).toBe("retain");
});

test("a stale owner PID cannot block a fresh collector token or cause a process signal", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-collector-stale-"));
    const root = join(home, ".genesis-tools/cmux");
    await installCapture({ home, screens: false });
    const staleToken = "11111111-1111-4111-8111-111111111111";
    writeFileSync(join(root, "screens.enabled"), staleToken);
    writeFileSync(join(root, "screens.pid.json"), SafeJSON.stringify({ pid: process.pid, ownerToken: staleToken }));
    writeFileSync(join(root, `screens.${staleToken}.lock`), "old owner");
    expect(screenCollectorStatus(root).running).toBe(false);
    try {
        const installed = await installCapture({ home });
        expect(installed.screens.running).toBe(true);
        expect(readFileSync(join(root, "screens.enabled"), "utf8")).not.toBe(staleToken);
    } finally {
        uninstallCapture({ home });
    }

    for (let attempt = 0; attempt < 60 && screenCollectorStatus(root).running; attempt++) {
        await Bun.sleep(25);
    }

    expect(screenCollectorStatus(root).running).toBe(false);
});

test("a new bundled collector version replaces the old owner without signaling it", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-collector-upgrade-"));
    const root = join(home, ".genesis-tools/cmux");
    try {
        const installed = await installCapture({ home });
        const runtimeDir = join(root, "runtime");
        const source = readdirSync(runtimeDir).find((n) => n.startsWith("capture-watch-"))!;
        const runtimePath = join(runtimeDir, "capture-watch-0000000000000000.js");
        copyFileSync(join(runtimeDir, source), runtimePath);
        expect(await enableScreenCollector({ root, runtimePath, bunPath: process.execPath })).toBe(true);
        expect(screenCollectorStatus(root).pid).not.toBe(installed.screens.pid);
    } finally {
        uninstallCapture({ home });
    }
    for (let attempt = 0; attempt < 60 && screenCollectorStatus(root).running; attempt++) {
        await Bun.sleep(25);
    }
    expect(screenCollectorStatus(root).running).toBe(false);
});

test("a malformed owner record reports not running instead of throwing", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-owner-repair-"));
    await installCapture({ home, screens: false });
    const root = join(home, ".genesis-tools/cmux");
    writeFileSync(join(root, "screens.pid.json"), "{broken");
    expect(screenCollectorStatus(root)).toMatchObject({ running: false, ownerMatches: false });
});
