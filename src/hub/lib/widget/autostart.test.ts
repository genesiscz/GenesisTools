import { describe, expect, test } from "bun:test";
import { ensureWidgetRunning, type WidgetAutostartDeps } from "./autostart";

function deps(over: Partial<WidgetAutostartDeps>): { deps: Partial<WidgetAutostartDeps>; launched: string[][] } {
    const launched: string[][] = [];
    return {
        launched,
        deps: {
            platform: "darwin",
            showWidget: async () => true,
            bundle: () => "/Users/alice/Applications/GenesisTools.app",
            widgetRunning: () => false,
            launch: (argv) => launched.push(argv),
            ...over,
        },
    };
}

describe("ensureWidgetRunning", () => {
    // 2026-11-02: after a reboot nothing started the widget, although its preference said shown.
    test("a shown widget that is not running is started in the background, once", async () => {
        const run = deps({});
        expect(await ensureWidgetRunning(run.deps)).toBe("started");
        expect(run.launched).toEqual([
            [
                "open",
                "-n",
                "-g",
                "/Users/alice/Applications/GenesisTools.app",
                "--args",
                "--widget",
                "--ensure-running",
                "--no-activate",
            ],
        ]);
    });

    test("a hidden widget, a running one, a missing app and another platform start nothing", async () => {
        for (const [over, result] of [
            [{ showWidget: async () => false }, "hidden"],
            [{ widgetRunning: () => true }, "running"],
            [{ bundle: () => null }, "no-app"],
            [{ platform: "linux" as NodeJS.Platform }, "not-macos"],
        ] as const) {
            const run = deps(over);
            expect(await ensureWidgetRunning(run.deps)).toBe(result);
            expect(run.launched).toEqual([]);
        }
    });
});
