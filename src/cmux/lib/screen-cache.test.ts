import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    advanceScreenEpoch,
    loadSavedScreens,
    preferredScreenText,
    pruneSavedScreens,
    saveSurfaceScreen,
} from "@app/cmux/lib/screen-cache";

const surfaceId = "11111111-1111-4111-8111-111111111111";
const stableSurfaceId = "22222222-2222-4222-8222-222222222222";

test("saved output survives restart and later output updates with a historical cutoff", () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-screen-test-"));
    advanceScreenEpoch({ directory, epoch: "before" });
    saveSurfaceScreen({ directory, surfaceId, stableSurfaceId, text: "service ready", atMs: 10 });
    advanceScreenEpoch({ directory, epoch: "after" });
    for (let i = 20; i <= 50; i += 10) {
        saveSurfaceScreen({ directory, surfaceId, stableSurfaceId, text: `new output ${i}`, atMs: i });
    }
    expect(loadSavedScreens({ directory, beforeMs: 15 }).get(stableSurfaceId)?.text).toBe("service ready");
    expect(loadSavedScreens({ directory }).get(surfaceId)?.text).toBe("new output 50");
    expect(loadSavedScreens({ directory, beforeMs: 5 }).size).toBe(0);
});

test("screen cache refuses a path-like identity before writing", () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-screen-invalid-"));
    expect(() => saveSurfaceScreen({ directory, surfaceId: "../outside", text: "example", atMs: 1 })).toThrow();
    expect(loadSavedScreens({ directory }).size).toBe(0);
});

test("unchanged viewports do not rewrite the cache and retention obeys its byte budget", () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-screen-budget-"));
    expect(saveSurfaceScreen({ directory, surfaceId, text: "a".repeat(2000), atMs: 10 })).toBe(true);
    expect(saveSurfaceScreen({ directory, surfaceId, text: "a".repeat(2000), atMs: 20 })).toBe(false);
    expect(loadSavedScreens({ directory }).get(surfaceId)?.atMs).toBe(10);
    saveSurfaceScreen({ directory, surfaceId, text: "b".repeat(2000), atMs: 30 });
    pruneSavedScreens({ directory, maxBytes: 2500 });
    const bytes = readdirSync(directory)
        .filter((p) => p.endsWith(".json"))
        .reduce((total, p) => total + statSync(join(directory, p)).size, 0);
    expect(bytes).toBeLessThanOrEqual(2500);
    expect(loadSavedScreens({ directory }).get(surfaceId)?.text).toBe("b".repeat(2000));
});

test("a malformed current entry is repaired without archiving its damaged bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-screen-repair-"));
    writeFileSync(join(directory, `${surfaceId}.json`), "{broken");
    expect(saveSurfaceScreen({ directory, surfaceId, text: "fresh output", atMs: 10 })).toBe(true);
    expect(loadSavedScreens({ directory }).get(surfaceId)?.text).toBe("fresh output");
    expect(existsSync(join(directory, `${surfaceId}.previous.json`))).toBe(false);
});

test("live and offline viewport selection falls back only when native text is empty", () => {
    for (const native of [undefined, "", "  \n", "\u001b[0m\n"]) {
        expect(preferredScreenText(native, "cached output\n")).toBe("cached output");
    }
    expect(preferredScreenText("native output\n", "cached output")).toBe("native output");
});
