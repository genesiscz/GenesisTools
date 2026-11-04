import { describe, expect, it } from "bun:test";
import type { MobileProject } from "@genesiscz/utils/mobile/project";
import { builtAppPath } from "./build";
import { compareFingerprints } from "./fingerprint";
import { stamp } from "./paths";
import { chooseDevice, choosePlatform, PLATFORMS } from "./platforms";
import { mergeAndroidDevices } from "./platforms/android";
import { resolveRoute, selectRoutes } from "./routes";
import { chooseDeviceType, chooseRuntime, fitsWidth, simulatorNameFor } from "./simulator-fit";

describe("build staleness", () => {
    it("names the inputs that changed, appeared or went", () => {
        expect(
            compareFingerprints(
                { "a.ts": "1:1", "b.ts": "2:2", "gone.ts": "3:3" },
                { "a.ts": "1:1", "b.ts": "2:9", "new.ts": "4:4" }
            )
        ).toEqual(["b.ts", "gone.ts", "new.ts"]);
    });

    it("finds the built .app for a configuration in DerivedData", () => {
        const ios = { build: { workspace: "w", scheme: "s", configuration: "Release" as const, productName: "Shop" } };
        expect(builtAppPath(ios, "/dd", "Debug")).toBe("/dd/Build/Products/Debug-iphonesimulator/Shop.app");
    });
});

describe("run folders", () => {
    it("stamps in local time", () => {
        expect(stamp(new Date(2026, 10, 4, 21, 5, 33))).toBe("2026-11-04T21-05-33");
    });
});

describe("simulator for a width", () => {
    const type = (name: string, model: string) => ({
        identifier: `com.apple.CoreSimulator.SimDeviceType.${name.replace(/ /g, "-")}`,
        name,
        productFamily: "iPhone",
        bundlePath: `/types/${name}.simdevicetype`,
        modelIdentifier: model,
    });

    it("picks the exact width, then the sharper screen, then the newest model", () => {
        const fits = [
            { type: type("iPhone 16 Pro", "iPhone17,1"), screen: { width: 402, height: 874, scale: 3 } },
            { type: type("iPhone 17 Pro", "iPhone18,1"), screen: { width: 402, height: 874, scale: 3 } },
            { type: type("iPhone 17", "iPhone18,3"), screen: { width: 393, height: 852, scale: 3 } },
        ];
        expect(fitsWidth({ width: 375, height: 667, scale: 2 }, 376)).toBe(true);
        expect(chooseDeviceType(fits, 402)?.type.name).toBe("iPhone 17 Pro");
        expect(chooseDeviceType(fits, 393)?.type.name).toBe("iPhone 17");
        expect(chooseDeviceType(fits, 430)).toBeNull();
        expect(simulatorNameFor(402)).toBe("gt-w402");
    });

    it("picks the newest runtime that runs the type, or the asked version", () => {
        const runtimes = [
            {
                identifier: "ios-26-5",
                version: "26.5",
                platform: "iOS",
                isAvailable: true,
                supportedDeviceTypes: ["t"],
            },
            {
                identifier: "ios-27-2",
                version: "27.2",
                platform: "iOS",
                isAvailable: true,
                supportedDeviceTypes: ["t"],
            },
            {
                identifier: "ios-28-0",
                version: "28.0",
                platform: "iOS",
                isAvailable: false,
                supportedDeviceTypes: ["t"],
            },
        ];
        expect(chooseRuntime(runtimes, "t")?.version).toBe("27.2");
        expect(chooseRuntime(runtimes, "t", "26.5")?.version).toBe("26.5");
        expect(chooseRuntime(runtimes, "t", "26")?.version).toBe("26.5");
        expect(chooseRuntime(runtimes, "other")).toBeNull();
    });
});

describe("routes", () => {
    const routes = [
        { name: "home", url: "shop:///", rootId: "screen-home" },
        { name: "order", url: "shop://order", rootId: "screen-order" },
    ];

    it("resolves a name, a name with a query that keeps the root, and a whole URL", () => {
        expect(resolveRoute(routes, "home")).toEqual(routes[0]);
        expect(resolveRoute(routes, "order?id=a1")).toEqual({
            name: "order",
            url: "shop://order?id=a1",
            rootId: "screen-order",
        });
        expect(resolveRoute(routes, "shop://cart")).toEqual({ name: "link", url: "shop://cart" });
        expect(() => resolveRoute(routes, "nope")).toThrow('no route "nope"');
    });

    it("selects all routes, the named ones, or refuses a list with no match", () => {
        expect(selectRoutes(routes)).toHaveLength(2);
        expect(selectRoutes(routes, ["order"]).map((route) => route.name)).toEqual(["order"]);
        expect(() => selectRoutes(routes, ["nope"])).toThrow("no route matches nope");
        expect(() => selectRoutes([])).toThrow("the project names none");
    });
});

describe("platforms", () => {
    const project = (platforms: MobileProject["config"]["platforms"]): MobileProject => ({
        configPath: "/p/mobile.config.ts",
        appDir: "/p",
        config: { id: "shop", platforms },
    });
    const ios = {
        bundleId: "com.example.shop",
        build: { workspace: "w", scheme: "s", configuration: "Release" as const, productName: "Shop" },
    };

    it("takes the asked platform, else the project's only one, else asks for --platform", () => {
        expect(choosePlatform("android", null).id).toBe("android");
        expect(choosePlatform(undefined, project({ ios })).id).toBe("ios");
        expect(() => choosePlatform(undefined, project({ ios, android: { packageName: "com.example.shop" } }))).toThrow(
            "names ios and android"
        );
        expect(() => choosePlatform(undefined, null)).toThrow("no project config");
        expect(() => choosePlatform("windows", null)).toThrow('--platform must be ios or android, not "windows"');
    });

    it("gives each platform the project's app id, launch activity and build", () => {
        const both = project({
            ios,
            android: { packageName: "com.example.shop", activity: ".Main", apk: "out/a.apk" },
        });
        expect(PLATFORMS.android.app(both)).toEqual({
            id: "com.example.shop",
            activity: ".Main",
            artifact: "/p/out/a.apk",
        });
        expect(PLATFORMS.ios.app(both)).toEqual({
            id: "com.example.shop",
            artifact: "/p/ios/build/Build/Products/Release-iphonesimulator/Shop.app",
        });
    });

    it("lists running Android devices by AVD name and idle AVDs as bootable entries", () => {
        const devices = mergeAndroidDevices({
            adb: [
                { serial: "emulator-5554", state: "device", model: "sdk_gphone", emulator: true },
                { serial: "R5CT1234ABC", state: "unauthorized", emulator: false },
            ],
            avds: ["Pixel_9", "Tablet"],
            running: { "emulator-5554": "Pixel_9" },
            versions: { "emulator-5554": "15" },
        });

        expect(devices.map((device) => [device.id, device.name, device.state, device.kind])).toEqual([
            ["emulator-5554", "Pixel_9", "booted", "emulator"],
            ["R5CT1234ABC", "R5CT1234ABC", "offline", "device"],
            ["avd:Tablet", "Tablet", "shutdown", "emulator"],
        ]);
    });

    it("picks the asked device, else the only booted one, and refuses when several are booted", () => {
        const device = (id: string, state: "booted" | "shutdown") => ({
            platform: "ios" as const,
            id,
            name: `sim ${id}`,
            state,
            rawState: state,
            osVersion: "26.5",
            kind: "simulator" as const,
        });
        expect(chooseDevice([device("a", "booted"), device("b", "shutdown")]).id).toBe("a");
        expect(chooseDevice([device("a", "booted"), device("b", "booted")], "sim b").id).toBe("b");
        expect(() => chooseDevice([device("a", "booted"), device("b", "booted")])).toThrow("2 devices are booted");
        expect(() => chooseDevice([device("b", "shutdown")], "b")).toThrow("boot it first");
        expect(() => chooseDevice([])).toThrow("no device is booted");
    });
});
