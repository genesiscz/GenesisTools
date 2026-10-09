import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import {
    addCaptureFlags,
    captureFromFlags,
    nativeCaptureArgv,
    parseNativeWindowList,
    parseScreenList,
    projectCropRegion,
    resolveCaptureEnumFlags,
    type ScreenInfo,
    screenCaptureFrame,
    validateCaptureOptions,
} from "./native-record";

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

    // The two lists are built differently, so an ordinal is not a shared name for a window.
    it("names a window by its CG id alone when the plan carries one", () => {
        const argv = nativeCaptureArgv(
            { mode: "window", app: "Genesis", windowTitle: "Settings", windowIndex: 1, windowId: 40231, duration: 3 },
            "/tmp/s"
        );
        expect(argv).toEqual([
            "capture",
            "--mode",
            "window",
            "--duration",
            "3",
            "--out",
            "/tmp/s",
            "--window-id",
            "40231",
        ]);
        expect(argv).not.toContain("--window-index");
        expect(argv).not.toContain("--app");
    });

    it("falls back to app, title and index when no id is available", () => {
        expect(nativeCaptureArgv({ mode: "window", app: "Genesis", windowIndex: 2, duration: 1 }, "/o")).toEqual([
            "capture",
            "--mode",
            "window",
            "--duration",
            "1",
            "--out",
            "/o",
            "--app",
            "Genesis",
            "--window-index",
            "2",
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

describe("isolated capture contract", () => {
    it("uses the same flags for direct capture and generated plans", () => {
        const command = addCaptureFlags(new Command()).option("--duration <s>");
        command.parse(
            [
                "--window-ids",
                "12,34",
                "--include-app",
                "123",
                "--include-app",
                "Example App",
                "--canvas",
                "display",
                "--screen-index",
                "1",
                "--output-size",
                "200x800",
                "--transparent",
                "--codec",
                "prores4444",
                "--no-indicator",
                "--video-out",
                "/tmp/example.mov",
                "--duration",
                "4",
            ],
            { from: "user" }
        );
        const capture = captureFromFlags(command.opts());
        expect(capture).toMatchObject({
            mode: "isolated",
            windowIds: [12, 34],
            apps: ["123", "Example App"],
            canvas: "display",
            screenIndex: 1,
            outputSize: { width: 200, height: 800 },
            transparent: true,
            codec: "prores4444",
            indicator: false,
            duration: 4,
        });
        const argv = nativeCaptureArgv(capture, "/tmp/isolated-fixture");
        expect(argv.join(" ")).toContain(
            "--window-ids 12,34 --include-app 123 --include-app Example App --canvas display"
        );
        expect(argv).toContain("--no-indicator");
        expect(argv).toContain("--transparent");
        expect(argv).toContain("200x800");
    });

    it("defaults to the visible indicator and native scale without inventing output detail", () => {
        const command = addCaptureFlags(new Command());
        command.parse(["--window-ids", "12"], { from: "user" });
        const capture = captureFromFlags(command.opts());
        expect(capture.indicator).toBe(true);
        expect(capture.outputSize).toBeUndefined();
        expect(capture.outputScale).toBeUndefined();
        expect(nativeCaptureArgv(capture, "/tmp/o")).not.toContain("--no-indicator");
    });

    it("supports PNG alpha without a movie and explicit point-to-pixel scaling", () => {
        expect(
            nativeCaptureArgv(
                { mode: "isolated", windowIds: [12], duration: 1, transparent: true, outputScale: 2 },
                "/tmp/o"
            )
        ).toContain("--output-scale");
        expect(() =>
            validateCaptureOptions({
                mode: "isolated",
                apps: ["Example"],
                duration: 1,
                transparent: true,
                codec: "prores4444",
                videoOut: "/tmp/alpha.mov",
                outputSize: { width: 201, height: 801 },
            })
        ).not.toThrow();
    });

    it("refuses unsupported alpha and ambiguous selections before starting any recorder", () => {
        const base = { mode: "isolated" as const, windowIds: [12], duration: 1 };
        for (const extra of [
            { transparent: true, videoOut: "/tmp/a.mp4" },
            { codec: "prores4444" as const, videoOut: "/tmp/a.mp4" },
            { backend: "peekaboo" as const },
            { windowId: 44 },
            { app: "Example" },
            { outputSize: { width: 200, height: 800 }, outputScale: 2 },
            { outputSize: { width: 201, height: 800 }, videoOut: "/tmp/a.mp4" },
            { outputScale: Number.NaN },
            { screenIndex: -1 },
            { duration: 181 },
        ]) {
            expect(() => validateCaptureOptions({ ...base, ...extra })).toThrow();
        }
        for (const outputSize of ["200x800x2", "200xx800", "200xgarbagex800", " 200x800", "200x"]) {
            expect(() => captureFromFlags({ windowIds: "12", outputSize })).toThrow(/outputSize/);
        }
        expect(() => validateCaptureOptions({ mode: "isolated", duration: 1 })).toThrow();
        expect(() => validateCaptureOptions({ mode: "isolated", windowIds: [0], duration: 1 })).toThrow();
        expect(() => validateCaptureOptions({ mode: "screen", windowIds: [12], duration: 1 })).toThrow();
    });

    it("settles --canvas and --codec as closed sets: a bare or unknown value stops with the choices", async () => {
        const parse = (args: string[]) => addCaptureFlags(new Command()).parse(args, { from: "user" }).opts();

        expect(parse(["--canvas"]).canvas).toBe(true);
        for (const args of [["--canvas"], ["--codec"], ["--canvas", "full"], ["--codec", "vp9"]]) {
            expect(
                await resolveCaptureEnumFlags(parse(["--window-ids", "12", ...args]), {
                    subcommand: ["capture", "record"],
                    interactive: false,
                })
            ).toBeUndefined();
        }

        const settled = await resolveCaptureEnumFlags(parse(["--window-ids", "12", "--codec", "prores4444"]), {
            subcommand: ["capture", "record"],
            interactive: false,
        });
        expect(settled).toMatchObject({ canvas: "crop", codec: "prores4444" });
        // A caller that skipped the resolver still gets the validation message, never a default.
        expect(() => captureFromFlags({ windowIds: "12", canvas: true })).toThrow("canvas must be crop or display");
    });
});

describe("crop targets in a screen recording's own pixels", () => {
    const retina: ScreenInfo = {
        index: 0,
        name: "Built-in",
        isPrimary: true,
        points: { width: 1512, height: 982 },
        scaleFactor: 2,
        framePixels: { width: 3024, height: 1964 },
        originCG: { x: 0, y: 0 },
    };
    const window = { x: 100, y: 50, w: 400, h: 300 };

    it("uses the backing scale when the plan sets no output geometry", () => {
        const frame = screenCaptureFrame({ mode: "screen", duration: 1 }, retina);
        expect(frame).toEqual({ width: 3024, height: 1964, scale: 2, padX: 0, padY: 0 });
        expect(projectCropRegion(window, retina, frame)).toEqual({ region: { x: 200, y: 100, w: 800, h: 600 } });
    });

    it("a Retina display recorded at outputScale 1 crops at one pixel per point", () => {
        const frame = screenCaptureFrame({ mode: "screen", duration: 1, outputScale: 1 }, retina);
        expect(frame).toMatchObject({ width: 1512, height: 982, scale: 1 });
        expect(projectCropRegion(window, retina, frame)).toEqual({ region: { x: 100, y: 50, w: 400, h: 300 } });
    });

    it("an explicit output size adds the aspect-fit padding and clips to the display's content", () => {
        const frame = screenCaptureFrame(
            { mode: "screen", duration: 1, outputSize: { width: 1512, height: 1200 } },
            retina
        );
        expect(frame.scale).toBe(1);
        expect(frame.padY).toBe(109);
        expect(projectCropRegion(window, retina, frame)).toEqual({ region: { x: 100, y: 159, w: 400, h: 300 } });
        expect(projectCropRegion({ x: -50, y: 900, w: 100, h: 200 }, retina, frame)).toEqual({
            region: { x: 0, y: 1009, w: 50, h: 82 },
        });
        expect("error" in projectCropRegion({ x: 2000, y: 0, w: 10, h: 10 }, retina, frame)).toBe(true);
    });
});
