import { describe, expect, it } from "bun:test";
import { devDashboardApp } from "@app/mobile/apps/dev-dashboard/adapter";
import { compareVersions, xcuitestXcodeProblem } from "@genesiscz/utils/mobile/appium";
import { runtimeVersion, wdaPortsFor } from "@genesiscz/utils/mobile/simulator";

describe("mobile simulator helpers", () => {
    it("gives each udid a stable WDA port in its own slot, MJPEG 1000 above it", () => {
        const first = wdaPortsFor("7E643E76-3FD9-4C9F-B89F-D9AF2937527B");
        const again = wdaPortsFor("7E643E76-3FD9-4C9F-B89F-D9AF2937527B");
        const other = wdaPortsFor("9719DCEE-0000-4000-8000-000000000000");

        expect(again).toEqual(first);
        expect(first.wda).toBeGreaterThanOrEqual(18100);
        expect(first.wda).toBeLessThan(19000);
        expect(first.mjpeg - first.wda).toBe(1000);
        expect(other.wda).not.toBe(first.wda);
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

describe("dev-dashboard adapter", () => {
    it("lists the tabs in tab bar order, then every (more) screen, with the app's deep links", () => {
        const routes = devDashboardApp.routes(devDashboardApp.locate());
        const names = routes.map((route) => route.name);

        expect(names.slice(0, 5)).toEqual(["pulse", "terminals", "qa", "obsidian", "more"]);
        expect(routes[0].url).toBe("devdashboard:///");
        expect(routes.find((route) => route.name === "weather")?.url).toBe("devdashboard://weather");
        expect(names).not.toContain("_layout");
        expect(names.slice(-2)).toEqual(["connect", "pair"]);
        expect(new Set(names).size).toBe(names.length);
    });

    it("reads the bundle id from app.json", () => {
        expect(devDashboardApp.bundleId(devDashboardApp.locate())).toMatch(/^[a-z0-9.-]+$/);
    });
});
