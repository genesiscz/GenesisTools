import { describe, expect, it } from "bun:test";
import { devDashboardApp } from "@app/mobile/apps/dev-dashboard/adapter";
import { findById, flatten, formatTree, parseSource, readLogBox, summarize } from "@genesiscz/utils/mobile/a11y";
import { decideAlert } from "@genesiscz/utils/mobile/alerts";
import { appiumPortFor, compareVersions, xcuitestXcodeProblem } from "@genesiscz/utils/mobile/appium";
import { readMetroLog } from "@genesiscz/utils/mobile/metro";
import { runtimeVersion, wdaPortsFor } from "@genesiscz/utils/mobile/simulator";
import { countResults, formatSummary, listSpecs, resolveSpecs, specFailed, suiteSpecs } from "./e2e";
import { compareFingerprints } from "./fingerprint";
import { stamp } from "./paths";
import { resolveRoute } from "./routes";
import { chooseDeviceType, chooseRuntime, fitsWidth, simulatorNameFor } from "./simulator-fit";

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

describe("system alert rules", () => {
    it("opens our app's link, cancels another build's, and leaves unknown alerts alone", () => {
        expect(decideAlert("Open in “Dev Dashboard”?", "Dev Dashboard")).toEqual({
            rule: "open-in",
            buttons: ["Open"],
        });
        expect(decideAlert("Open in “Other Build”?", "Dev Dashboard").buttons).toEqual(["Cancel"]);
        expect(decideAlert("Open in “Dev Dashboard”?", "").buttons).toBeNull();
        expect(decideAlert("“Dev Dashboard” Would Like to Send You Notifications", "Dev Dashboard").buttons).toEqual([
            "Allow",
        ]);
        expect(decideAlert("“Other” Would Like to Send You Notifications", "Dev Dashboard").buttons).toBeNull();
        // The app's own destructive confirmation must never be answered by the watcher.
        expect(decideAlert("Stop this session?\nEnds shop (pid 41001)", "Dev Dashboard")).toEqual({
            rule: null,
            buttons: null,
        });
    });
});

const SOURCE = `<?xml version="1.0" encoding="UTF-8"?><AppiumAUT>
<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Dev Dashboard" label="Dev Dashboard" enabled="true" visible="true" x="0" y="0" width="402" height="874">
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

describe("build staleness", () => {
    it("names the inputs that changed, appeared or went", () => {
        expect(
            compareFingerprints(
                { "a.ts": "1:1", "b.ts": "2:2", "gone.ts": "3:3" },
                { "a.ts": "1:1", "b.ts": "2:9", "new.ts": "4:4" }
            )
        ).toEqual(["b.ts", "gone.ts", "new.ts"]);
    });
});

describe("routes and the e2e suite", () => {
    const appDir = devDashboardApp.locate();

    it("covers the phase 7 screens and resolves a route with a query", () => {
        const names = devDashboardApp.routes(appDir).map((route) => route.name);
        expect(names).toContain("agents");
        expect(names).toContain("agent-session");
        const session = resolveRoute(devDashboardApp, appDir, "agent-session?key=claude:a1");
        expect(session.url).toBe("devdashboard://agent-session?key=claude:a1");
        expect(session.rootId).toBe("screen-agent-session");
        expect(resolveRoute(devDashboardApp, appDir, "devdashboard://weather")).toEqual({
            name: "link",
            url: "devdashboard://weather",
        });
        expect(() => resolveRoute(devDashboardApp, appDir, "nope")).toThrow('no route "nope"');
    });

    it("finds the flow specs, resolves names and maps the run context to the runner's environment", () => {
        const flows = suiteSpecs(devDashboardApp, appDir, "flows").map((spec) => spec.name);
        expect(flows).toEqual(["pairing.flow", "answer-queue.flow", "agents.flow", "terminal.flow"]);
        const all = listSpecs(devDashboardApp, appDir);
        expect(resolveSpecs(all, ["agents"]).map((spec) => spec.name)).toEqual(["agents.flow"]);
        expect(() => resolveSpecs(all, ["nope"])).toThrow('no spec matches "nope"');
        const environment = devDashboardApp.e2e?.env({
            udid: "U",
            deviceName: "iPhone 17 Pro",
            osVersion: "26.5",
            appiumPort: 4950,
            wdaPort: 18750,
            bundleId: "b",
            runDir: "/runs/x/agents.flow",
            agentUrl: "http://127.0.0.1:3143",
        });
        expect(environment).toMatchObject({
            DD_SIM_UDID: "U",
            DD_APPIUM_PORT: "4950",
            DD_WDA_PORT: "18750",
            DD_RUN_DIR: "/runs/x/agents.flow",
            DD_TEST_AGENT: "http://127.0.0.1:3143",
        });
    });

    it("fails a spec that exited non-zero, failed a test, or ran none, and writes a summary", () => {
        const spec = { name: "agents.flow", path: "e2e/specs/agents.flow.spec.ts" };
        const passed = { suite: "Agents flow", title: "loads", state: "passed" as const, durationMs: 10 };
        const failed = { ...passed, title: "lists", state: "failed" as const, error: "expected [] got [x]\nstack" };
        expect(specFailed({ exitCode: 0, tests: [passed] })).toBe(false);
        expect(specFailed({ exitCode: 1, tests: [passed] })).toBe(true);
        expect(specFailed({ exitCode: 0, tests: [] })).toBe(true);
        const runs = [{ spec, dir: "/d", exitCode: 1, seconds: 3, log: "/d/wdio.log", tests: [passed, failed] }];
        expect(countResults(runs)).toEqual({ passed: 1, failed: 1, skipped: 0, specsFailed: 1 });
        const markdown = formatSummary({
            app: "dev-dashboard",
            runDir: "/runs/x",
            startedAt: "2026-11-04T21:00:00Z",
            finishedAt: "2026-11-04T21:01:00Z",
            device: { udid: "U", name: "gt-w402", osVersion: "26.5" },
            appiumPort: 4950,
            wdaPort: 18750,
            specs: runs,
            counts: countResults(runs),
            alerts: [{ at: "t", backend: "wda", text: "Open in “Dev Dashboard”?", rule: "open-in", tapped: "Open" }],
            ok: false,
        });
        expect(markdown).toContain("- FAIL agents.flow: 1/2 passed, exit 1");
        expect(markdown).toContain("    - Agents flow > lists: expected [] got [x]");
        expect(markdown).toContain("open-in: tapped Open");
    });

    it("gives each simulator its own Appium port and stamps runs in local time", () => {
        const port = appiumPortFor("7E643E76-3FD9-4C9F-B89F-D9AF2937527B");
        expect(port).toBeGreaterThanOrEqual(4900);
        expect(port).toBeLessThan(5000);
        expect(stamp(new Date(2026, 10, 4, 21, 5, 33))).toBe("2026-11-04T21-05-33");
    });
});
