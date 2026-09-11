import { describe, expect, it } from "bun:test";
import {
    clickArgv,
    moveArgv,
    parseWindowList,
    peekabooChord,
    pressArgv,
    scrollArgv,
    typeArgv,
    windowShotArgv,
} from "./peekaboo";

// Peekaboo 4 removed `list`, `hotkey` and `image`, renamed `--coords` to `--at`, and refuses
// untargeted background input. Every recorder action was built against the old grammar.
describe("recorder argv against Peekaboo 4", () => {
    it("clicks at a global point in the foreground", () => {
        expect(clickArgv("120,340")).toEqual(["click", "--at", "120,340", "--global", "--foreground"]);
    });

    it("moves the same way", () => {
        expect(moveArgv("-10,20")).toEqual(["move", "--at", "-10,20", "--global", "--foreground"]);
    });

    it("turns a comma key list into an xdotool chord for press", () => {
        expect(peekabooChord("cmd, shift ,a")).toBe("cmd+shift+a");
        expect(pressArgv("cmd,shift,a")).toEqual(["press", "cmd+shift+a", "--foreground"]);
        expect(pressArgv("return", 250)).toEqual(["press", "return", "--foreground", "--hold", "250"]);
    });

    it("types through --text so leading dashes survive", () => {
        expect(typeArgv("-v is a flag", 0)).toEqual([
            "type",
            "--text",
            "-v is a flag",
            "--profile",
            "linear",
            "--delay",
            "0",
            "--foreground",
        ]);
    });

    it("scrolls with an optional target and foreground consent last", () => {
        expect(scrollArgv({ direction: "down" })).toEqual([
            "scroll",
            "--direction",
            "down",
            "--amount",
            "3",
            "--foreground",
        ]);
        expect(scrollArgv({ direction: "up", amount: 7, app: "Genesis", windowTitle: "Settings" })).toEqual([
            "scroll",
            "--direction",
            "up",
            "--amount",
            "7",
            "--app",
            "Genesis",
            "--window-title",
            "Settings",
            "--foreground",
        ]);
    });

    it("shoots the clickmap window natively when ax-tool is built, else through see --no-elements", () => {
        expect(
            windowShotArgv({ axToolPath: "/bin/ax-tool", app: "Brave Browser", path: "/tmp/a.png", windowTitle: "PR" })
        ).toEqual(["/bin/ax-tool", "screenshot", "--app", "Brave Browser", "--path", "/tmp/a.png", "--window", "PR"]);
        expect(windowShotArgv({ app: "Brave Browser", path: "/tmp/a.png" })).toEqual([
            "peekaboo",
            "see",
            "--app",
            "Brave Browser",
            "--path",
            "/tmp/a.png",
            "--no-elements",
            "--json",
        ]);
    });
});

describe("parseWindowList", () => {
    it("reads the Peekaboo 4 shape, dropping off-screen windows", () => {
        const data = {
            windows: [
                {
                    window_title: "Calculator",
                    window_index: 0,
                    window_id: 24968,
                    is_key: true,
                    is_on_screen: true,
                    bounds: { x: 2137, y: -575, width: 230, height: 408 },
                },
                {
                    window_title: "Hidden",
                    window_index: 1,
                    window_id: 1,
                    is_key: false,
                    is_on_screen: false,
                    bounds: { x: 0, y: 0, width: 1, height: 1 },
                },
                { window_title: "No bounds", window_index: 2, window_id: 2, is_key: false, is_on_screen: true },
            ],
        };
        expect(parseWindowList(data)).toEqual([
            { title: "Calculator", index: 0, id: 24968, isMainWindow: true, x: 2137, y: -575, w: 230, h: 408 },
        ]);
    });

    it("still reads the Peekaboo 3 shape for an older install", () => {
        const data = {
            windows: [
                {
                    title: "Main",
                    index: 0,
                    isMainWindow: true,
                    isMinimized: false,
                    bounds: [
                        [10, 20],
                        [300, 400],
                    ],
                },
                {
                    title: "Minimized",
                    index: 1,
                    isMainWindow: false,
                    isMinimized: true,
                    bounds: [
                        [0, 0],
                        [1, 1],
                    ],
                },
            ],
        };
        expect(parseWindowList(data)).toEqual([
            { title: "Main", index: 0, isMainWindow: true, x: 10, y: 20, w: 300, h: 400 },
        ]);
    });

    it("is empty for an error envelope", () => {
        expect(parseWindowList(undefined)).toEqual([]);
        expect(parseWindowList({ error: "Command 'peekaboo list' was removed in v4." })).toEqual([]);
    });
});
