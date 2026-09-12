import { describe, expect, it } from "bun:test";
import { nativeCaptureArgv, parseNativeWindowList, parseScreenList } from "./native-record";

describe("nativeCaptureArgv", () => {
    it("records a window by app and title, duration in seconds as the plan says", () => {
        expect(
            nativeCaptureArgv(
                { mode: "window", app: "Genesis", windowTitle: "Settings", duration: 3, activeFps: 15, threshold: 0.1 },
                "/tmp/s"
            )
        ).toEqual([
            "capture",
            "--mode",
            "window",
            "--duration",
            "3",
            "--out",
            "/tmp/s",
            "--app",
            "Genesis",
            "--window-title",
            "Settings",
            "--active-fps",
            "15",
            "--threshold",
            "0.1",
        ]);
    });

    it("records a screen by index and a region by rect, ignoring fields for other modes", () => {
        expect(nativeCaptureArgv({ mode: "screen", screenIndex: 2, app: "ignored", duration: 1 }, "/o")).toEqual([
            "capture",
            "--mode",
            "screen",
            "--duration",
            "1",
            "--out",
            "/o",
            "--screen-index",
            "2",
        ]);
        expect(
            nativeCaptureArgv({ mode: "region", region: "10,20,300,200", duration: 2, videoOut: "/tmp/v.mp4" }, "/o")
        ).toEqual([
            "capture",
            "--mode",
            "region",
            "--duration",
            "2",
            "--out",
            "/o",
            "--region",
            "10,20,300,200",
            "--video-out",
            "/tmp/v.mp4",
        ]);
    });
});

describe("parseScreenList", () => {
    it("flips a Cocoa position from ax-tool screens into a CG origin", () => {
        const data = {
            screens: [
                {
                    index: 0,
                    name: "Built-in",
                    isPrimary: true,
                    scaleFactor: 2,
                    position: { x: 0, y: 0 },
                    resolution: { width: 2056, height: 1329 },
                },
                {
                    index: 1,
                    name: "External",
                    isPrimary: false,
                    scaleFactor: 1,
                    position: { x: -2560, y: 1329 },
                    resolution: { width: 2560, height: 1440 },
                },
            ],
        };
        const screens = parseScreenList(data, "cocoa");
        expect(screens[0]).toMatchObject({ framePixels: { width: 4112, height: 2658 }, originCG: { x: 0, y: 0 } });
        expect(screens[1].originCG).toEqual({ x: -2560, y: 1329 - (1329 + 1440) });
    });

    it("passes a CoreGraphics position through untouched, because Peekaboo already reports CG", () => {
        // Real `peekaboo screen list` output, measured 2026-09-12. The maximized window on
        // this display reports CG x=-1488 y=-1410: the x matches exactly and y differs by
        // the 30-point title strip, which is only possible if position is already CG.
        // Flipping it produced y=1329 instead of -1440, an error of 2769 points.
        const screens = parseScreenList(
            {
                screens: [
                    {
                        index: 0,
                        name: "Built-in",
                        isPrimary: true,
                        scaleFactor: 2,
                        position: { x: 0, y: 0 },
                        resolution: { width: 2056, height: 1329 },
                    },
                    {
                        index: 1,
                        name: "2560x1440 Display",
                        isPrimary: false,
                        scaleFactor: 1,
                        position: { x: -1488, y: -1440 },
                        resolution: { width: 2560, height: 1440 },
                    },
                ],
            },
            "coregraphics"
        );

        expect(screens[1].originCG).toEqual({ x: -1488, y: -1440 });
    });

    it("is empty for an error envelope", () => {
        expect(parseScreenList(undefined, "cocoa")).toEqual([]);
        expect(parseScreenList({ error: "nope" }, "coregraphics")).toEqual([]);
    });
});

describe("parseNativeWindowList", () => {
    it("maps ax-tool window output and drops minimized windows", () => {
        const data = {
            windows: [
                { title: "Calculator", x: 2137, y: -575, width: 230, height: 408, minimized: false },
                { title: "Hidden", x: 0, y: 0, width: 100, height: 100, minimized: true },
            ],
        };
        expect(parseNativeWindowList(data)).toEqual([
            { title: "Calculator", index: 0, isMainWindow: false, x: 2137, y: -575, w: 230, h: 408 },
        ]);
    });
});
