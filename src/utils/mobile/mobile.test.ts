import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { appiumPortFor, compareVersions, xcuitestXcodeProblem } from "./appium";
import { findMobileConfig, iosApp, loadMobileProject, parseMobileConfig, projectRoutes } from "./project";
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
