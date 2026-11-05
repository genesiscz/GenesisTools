import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import * as boundedCommands from "@genesiscz/utils/process/bounded-command";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { shellCommandLine } from "@genesiscz/utils/shell/quote";
import { findById, flatten, formatTree, parseSource, readLogBox, summarize } from "./a11y";
import { AlertWatcher, decideAlert } from "./alerts";
import { emulatorCommand, freeEmulatorPort, openAndroidUrl, parseAdbDevices } from "./android";
import { appiumPortFor, compareVersions, xcuitestXcodeProblem } from "./appium";
import { readMetroLog } from "./metro";
import { androidApp, findMobileConfig, iosApp, loadMobileProject, parseMobileConfig, projectRoutes } from "./project";
import { runtimeVersion, wdaPortsFor } from "./simulator";

const root = mkdtempSync(join(tmpdir(), "gt-mobile-project-"));

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

const IOS = {
    bundleId: "com.example.shop",
    build: { workspace: "ios/Shop.xcworkspace", scheme: "Shop", configuration: "Release", productName: "Shop" },
};

function writeConfig(dir: string, file: string, body: string): string {
    const path = join(dir, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
    return path;
}

describe("mobile simulator helpers", () => {
    it("gives each udid a stable WDA port in its own slot, MJPEG 1000 above it", () => {
        const first = wdaPortsFor("7E643E76-3FD9-4C9F-B89F-D9AF2937527B");
        const other = wdaPortsFor("9719DCEE-0000-4000-8000-000000000000");

        expect(wdaPortsFor("7E643E76-3FD9-4C9F-B89F-D9AF2937527B")).toEqual(first);
        expect(first.wda).toBeGreaterThanOrEqual(18100);
        expect(first.wda).toBeLessThan(19000);
        expect(first.mjpeg - first.wda).toBe(1000);
        expect(other.wda).not.toBe(first.wda);
        const port = appiumPortFor("7E643E76-3FD9-4C9F-B89F-D9AF2937527B");
        expect(port).toBeGreaterThanOrEqual(4900);
        expect(port).toBeLessThan(5000);
    });

    it("reads the iOS version from a runtime id", () => {
        expect(runtimeVersion("com.apple.CoreSimulator.SimRuntime.iOS-26-5")).toBe("26.5");
        expect(runtimeVersion("com.apple.CoreSimulator.SimRuntime.watchOS-11-0")).toBe("");
    });

    it("refuses an XCUITest driver older than 12.13 only when Xcode uses DeviceHub", () => {
        expect(compareVersions("12.22.8", "12.13.0")).toBeGreaterThan(0);
        expect(compareVersions("11.7.3", "12.13.0")).toBeLessThan(0);
        expect(xcuitestXcodeProblem("11.7.3", true)).toContain("xcuitest@12.22.8");
        expect(xcuitestXcodeProblem("11.7.3", false)).toBeNull();
        expect(xcuitestXcodeProblem("12.22.8", true)).toBeNull();
        expect(xcuitestXcodeProblem(null, false)).toContain("appium driver install");
    });
});

describe("mobile project config", () => {
    it("finds the nearest mobile.config.ts or e2e/mobile.config.ts upward", () => {
        const app = join(root, "find", "app");
        const deep = join(app, "src", "screens");
        mkdirSync(deep, { recursive: true });
        const nested = writeConfig(app, "e2e/mobile.config.ts", "export default {};");

        expect(findMobileConfig(deep)).toBe(nested);
        const direct = writeConfig(app, "mobile.config.ts", "export default {};");
        expect(findMobileConfig(deep)).toBe(direct);
        expect(findMobileConfig(join(root, "find"))).toBeNull();
    });

    it("names every problem in a config with its file", () => {
        expect(() =>
            parseMobileConfig({ id: "bad id!", platforms: { ios: { bundleId: "" } } }, "/p/mobile.config.ts")
        ).toThrow(/invalid mobile config \/p\/mobile\.config\.ts[\s\S]*id[\s\S]*build/);
        expect(parseMobileConfig({ id: "shop", platforms: { ios: IOS } }, "x").id).toBe("shop");
    });

    it("loads a project: the app folder from the config file, routes and the bundle id from functions", async () => {
        const dir = join(root, "load");
        const path = writeConfig(
            dir,
            "e2e/mobile.config.ts",
            `export default {
                id: "shop",
                appDir: "..",
                routes: (appDir) => [{ name: "home", url: "shop:///", rootId: appDir.endsWith("load") ? "screen-home" : "wrong" }],
                platforms: { ios: { ...${SafeJSON.stringify(IOS)}, bundleId: (appDir) => appDir.split("/").pop() + ".bundle" } },
            };`
        );
        const project = await loadMobileProject({ cwd: join(dir, "e2e") });

        expect(project.configPath).toBe(path);
        expect(project.appDir).toBe(dir);
        expect(projectRoutes(project)).toEqual([{ name: "home", url: "shop:///", rootId: "screen-home" }]);
        expect(iosApp(project).bundleId).toBe("load.bundle");
        expect(iosApp(project).buildInputs).toEqual({ native: [], js: [] });
    });

    it("refuses a folder with no config, a missing --config, and a project without the platform", async () => {
        const empty = join(root, "empty");
        mkdirSync(empty, { recursive: true });

        await expect(loadMobileProject({ cwd: empty })).rejects.toThrow("pass --config <file>");
        await expect(loadMobileProject({ cwd: empty, config: "nope.ts" })).rejects.toThrow("does not exist");
        writeConfig(empty, "android-only.config.ts", `export default { id: "a", platforms: {} };`);
        const project = await loadMobileProject({ cwd: empty, config: "android-only.config.ts" });
        expect(() => iosApp(project)).toThrow("has no platforms.ios");
    });
});
describe("system alert rules", () => {
    it("leaves unknown alerts untouched and taps a recognized own-app link", async () => {
        const backend = {
            kind: "wda" as const,
            read: async () => ({ text: "Delete this item?", buttons: ["Delete"] }),
            tap: async () => {
                throw new Error("must not tap an unknown alert");
            },
        };
        expect((await new AlertWatcher({ backend, appName: "Shop" }).check())?.tapped).toBeNull();
        let taps = 0;
        const own = {
            kind: "wda" as const,
            read: async () => ({ text: "Open in “Shop”?", buttons: ["Open"] }),
            tap: async () => {
                taps++;
                return "Open";
            },
        };
        expect((await new AlertWatcher({ backend: own, appName: "Shop" }).check())?.tapped).toBe("Open");
        expect(taps).toBe(1);
    });
    it("opens our app's link, cancels another build's, and leaves unknown alerts alone", () => {
        expect(decideAlert("Open in “Shop”?", "Shop")).toEqual({
            rule: "open-in",
            buttons: ["Open"],
        });
        expect(decideAlert("Open in “Other Shop”?", "Shop").buttons).toEqual(["Cancel"]);
        expect(decideAlert("Open in “Shop”?", "").buttons).toBeNull();
        expect(decideAlert("“Shop” Would Like to Send You Notifications", "Shop").buttons).toEqual(["Allow"]);
        expect(decideAlert("“Other” Would Like to Send You Notifications", "Shop").buttons).toBeNull();
        // The app's own destructive confirmation must never be answered by the watcher.
        expect(decideAlert("Stop this session?\nEnds shop (pid 41001)", "Shop")).toEqual({
            rule: null,
            buttons: null,
        });
    });
});

const SOURCE = `<?xml version="1.0" encoding="UTF-8"?><AppiumAUT>
<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Shop" label="Shop" enabled="true" visible="true" x="0" y="0" width="402" height="874">
  <XCUIElementTypeOther type="XCUIElementTypeOther" name="screen-agents" enabled="true" visible="true" x="0" y="0" width="402" height="874">
    <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" x="0" y="0" width="402" height="874">
      <XCUIElementTypeButton type="XCUIElementTypeButton" name="agent-row-claude:a1" label="Checkout &amp; cart" enabled="true" visible="true" x="16" y="120" width="370" height="90"/>
      <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="2 running" enabled="true" visible="true" x="16" y="90" width="80" height="20"/>
      <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="hidden words" enabled="true" visible="false" x="0" y="900" width="10" height="10"/>
    </XCUIElementTypeOther>
  </XCUIElementTypeOther>
</XCUIElementTypeApplication></AppiumAUT>`;

describe("accessibility tree", () => {
    it("parses the tree, decodes entities and folds anonymous containers", () => {
        const nodes = parseSource(SOURCE);
        expect(flatten(nodes)).toHaveLength(6);
        expect(findById(nodes, "agent-row-claude:a1")?.label).toBe("Checkout & cart");
        const tree = formatTree(nodes, { visibleOnly: true }).split("\n");
        expect(tree[1]).toBe("  Other #screen-agents [0,0 402x874]");
        expect(tree[2]).toBe('    Button "Checkout & cart" #agent-row-claude:a1 [16,120 370x90]');
        expect(tree.join("\n")).not.toContain("hidden words");
    });

    it("summarizes testIDs, visible words and tap targets", () => {
        const summary = summarize(parseSource(SOURCE));
        expect(summary.testIds).toEqual(["screen-agents", "agent-row-claude:a1"]);
        expect(summary.texts).toEqual(["2 running"]);
        expect(summary.buttons).toEqual([{ label: "Checkout & cart", id: "agent-row-claude:a1" }]);
        expect(summary.alerts).toEqual([]);
    });

    it("reads a collapsed and an expanded LogBox", () => {
        const text = (value: string, y: number) =>
            `<XCUIElementTypeStaticText value="${value}" visible="true" x="10" y="${y}" width="300" height="20"/>`;
        expect(readLogBox(parseSource(SOURCE)).state).toBe("none");
        const toast = parseSource(
            `<XCUIElementTypeOther name="2, Warning: Each child needs a key" visible="true" x="10" y="800" width="380" height="48"/>`
        );
        expect(readLogBox(toast)).toMatchObject({ state: "collapsed", message: ["Warning: Each child needs a key"] });
        const expanded = readLogBox(
            parseSource(
                `<XCUIElementTypeOther>${text("Log 2 of 3", 60)}${text("Console Error", 100)}${text("Network request failed", 130)}${text("Source", 160)}${text("Network request failed", 131)}<XCUIElementTypeButton label="Dismiss" visible="true" x="0" y="820" width="200" height="40"/><XCUIElementTypeButton label="Minimize" visible="true" x="200" y="820" width="200" height="40"/>${text("under the overlay", 900)}</XCUIElementTypeOther>`
            )
        );
        expect(expanded).toMatchObject({
            state: "expanded",
            index: 2,
            total: 3,
            heading: "Console Error",
            message: ["Network request failed"],
            headerY: 70,
        });
        expect(expanded.minimize?.label).toBe("Minimize");
    });
});

describe("metro log", () => {
    it("reads only the lines after the newest bundle", () => {
        const report = readMetroLog(
            [
                "iOS Bundled 900ms node_modules/expo-router/entry.js",
                " ERROR  [TypeError: old failure]",
                "iOS Bundled 120ms node_modules/expo-router/entry.js",
                " LOG  app booted",
                " WARN  slow query",
            ].join("\n")
        );
        expect(report.ran).toBe(true);
        expect(report.fatal).toEqual([]);
        expect(report.console).toEqual(["WARN  slow query"]);
        expect(readMetroLog("Bundling failed: Unable to resolve module ./missing").fatal).toHaveLength(1);
        expect(readMetroLog("Starting Metro Bundler\nWaiting on http://localhost:8091").ran).toBe(false);
    });
});

describe("android", () => {
    it("parses adb devices -l, flags emulators and reads the model", () => {
        const devices = parseAdbDevices(
            [
                "List of devices attached",
                "emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 transport_id:1",
                "R5CT1234ABC            unauthorized usb:1-1 transport_id:2",
                "",
            ].join("\n")
        );

        expect(devices).toEqual([
            { serial: "emulator-5554", state: "device", model: "sdk_gphone64_arm64", emulator: true },
            { serial: "R5CT1234ABC", state: "unauthorized", model: undefined, emulator: false },
        ]);
    });

    it("picks the first console port no listed emulator holds, and builds a clean-boot command", () => {
        const listed = [
            { serial: "emulator-5554", state: "device", emulator: true },
            { serial: "emulator-5558", state: "offline", emulator: true },
        ];
        expect(freeEmulatorPort(listed)).toBe(5556);
        expect(freeEmulatorPort([])).toBe(5554);
        expect(emulatorCommand({ avd: "Pixel_9", port: 5556 }).slice(1)).toEqual([
            "-avd",
            "Pixel_9",
            "-port",
            "5556",
            "-no-snapshot-save",
            "-no-boot-anim",
            "-gpu",
            "host",
            "-noaudio",
        ]);
    });

    it("reads an android platform from the config and refuses a bad package name", async () => {
        const raw = { id: "shop", platforms: { android: { packageName: "com.example.shop", apk: "build/app.apk" } } };
        expect(parseMobileConfig(raw, "x").platforms.android?.packageName).toBe("com.example.shop");
        expect(() => parseMobileConfig({ id: "shop", platforms: { android: { packageName: "shop" } } }, "x")).toThrow(
            "packageName"
        );
        const project = { configPath: "/p/mobile.config.ts", appDir: "/p", config: parseMobileConfig(raw, "x") };
        expect(androidApp(project).apk).toBe("build/app.apk");
        expect(() => iosApp(project)).toThrow("has no platforms.ios");
    });
});

it("streams verbose build output without the captured-output ceiling", async () => {
    let bytes = 0;
    const result = await boundedCommand({
        command: [process.execPath, "-e", "process.stdout.write('x'.repeat(5 * 1024 * 1024))"],
        timeoutMs: 10_000,
        streamOnly: true,
        onStdout: (chunk) => {
            bytes += chunk.byteLength;
        },
    });
    expect(result.status).toBe(0);
    expect(bytes).toBe(5 * 1024 * 1024);
    expect(result.stdout.length).toBeLessThanOrEqual(16_384);
});

it("quotes a deep link as one remote shell argument before adb receives it", async () => {
    const spy = spyOn(boundedCommands, "boundedCommand").mockResolvedValue({
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
    });
    const url = "shop://cart?a=1&b=$(printf injected);printf wrong";
    try {
        await openAndroidUrl({ serial: "fixture-device", url });
        expect(spy.mock.calls[0][0].command.slice(-2)).toEqual([
            "shell",
            shellCommandLine(["am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", url]),
        ]);
    } finally {
        spy.mockRestore();
    }
});
