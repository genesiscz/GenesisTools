import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestCase, TestResult } from "@playwright/test/reporter";
import { playwrightState, playwrightTestResult } from "./playwright-reporter";
import { findE2eConfig, loadE2eProject, parseE2eConfig } from "./project";
import {
    E2E_ENV,
    failureScreenshotPath,
    readE2eSpecContext,
    recordTestResult,
    wdioTestResult,
    xcuitestCapabilities,
} from "./spec-env";

const root = mkdtempSync(join(tmpdir(), "gt-e2e-project-"));

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

const RUN_ENV = {
    [E2E_ENV.runDir]: "/runs/a/agents.flow",
    [E2E_ENV.udid]: "SIM-1",
    [E2E_ENV.deviceName]: "gt-w402",
    [E2E_ENV.deviceOs]: "26.5",
    [E2E_ENV.appiumPort]: "4950",
    [E2E_ENV.wdaPort]: "18750",
    [E2E_ENV.mjpegPort]: "19750",
    [E2E_ENV.bundleId]: "com.example.shop",
    [E2E_ENV.headless]: "1",
};

describe("spec environment", () => {
    it("reads the run a spec process got, and nothing outside tools e2e", () => {
        expect(readE2eSpecContext(RUN_ENV)).toMatchObject({
            runDir: "/runs/a/agents.flow",
            resultsFile: "/runs/a/agents.flow/results.jsonl",
            shotsDir: "/runs/a/agents.flow/shots",
            device: { udid: "SIM-1", name: "gt-w402", os: "26.5" },
            appiumPort: 4950,
            wdaPort: 18750,
            headless: true,
        });
        expect(readE2eSpecContext({})).toEqual({
            runDir: undefined,
            resultsFile: undefined,
            shotsDir: undefined,
            spec: undefined,
            project: undefined,
            device: undefined,
            appiumPort: undefined,
            wdaPort: undefined,
            mjpegPort: undefined,
            bundleId: undefined,
            headless: undefined,
            baseUrl: undefined,
        });
    });

    it("pins the simulator, its ports and isHeadless in the XCUITest capabilities", () => {
        const capabilities = xcuitestCapabilities(readE2eSpecContext(RUN_ENV), { bundleId: "com.example.shop" });
        expect(capabilities).toMatchObject({
            "appium:udid": "SIM-1",
            "appium:bundleId": "com.example.shop",
            "appium:noReset": true,
            "appium:wdaLocalPort": 18750,
            "appium:mjpegServerPort": 19750,
            "appium:isHeadless": true,
        });
        const install = xcuitestCapabilities(
            {},
            { bundleId: "b", app: "/build/Shop.app", deviceName: "iPhone 17 Pro" }
        );
        expect(install["appium:app"]).toBe("/build/Shop.app");
        expect(install).not.toHaveProperty("appium:udid");
        expect(install["appium:deviceName"]).toBe("iPhone 17 Pro");
    });

    it("maps WebdriverIO's afterTest to a line: a pending test is a skip, a failure keeps its message", () => {
        const test = { parent: "Agents flow", title: "lists the sessions" };
        expect(wdioTestResult({ test, result: { passed: true, duration: 12 } }).state).toBe("passed");
        expect(wdioTestResult({ test, result: { passed: false, duration: 0, retries: { attempts: -1 } } }).state).toBe(
            "skipped"
        );
        expect(
            wdioTestResult({
                test,
                result: { passed: false, duration: 5, error: new Error("expected 2 got 3") },
                screenshot: "/s.png",
            })
        ).toEqual({
            suite: "Agents flow",
            title: "lists the sessions",
            state: "failed",
            durationMs: 5,
            error: "expected 2 got 3",
            screenshot: "/s.png",
        });
        expect(failureScreenshotPath({ shotsDir: "/shots" }, test)).toBe(
            "/shots/FAIL_Agents_flow_lists_the_sessions.png"
        );
    });

    it("appends one JSON line per test, and records nothing without a results file", () => {
        const resultsFile = join(root, "results", "results.jsonl");
        const line = { suite: "s", title: "t", state: "passed" as const, durationMs: 1 };
        recordTestResult({ resultsFile }, line);
        recordTestResult({ resultsFile }, { ...line, title: "u" });
        recordTestResult({}, line);
        expect(readFileSync(resultsFile, "utf8").trim().split("\n")).toHaveLength(2);
    });

    it("maps a Playwright test to a line, with the describe blocks as its suite", () => {
        const test = { title: "pays", titlePath: () => ["", "chromium", "checkout.spec.ts", "Checkout", "pays"] };
        const result = {
            status: "timedOut",
            duration: 30_000,
            error: { message: "Timeout 30000ms exceeded" },
            attachments: [{ name: "screenshot", contentType: "image/png", path: "/out/shot.png" }],
        };
        expect(playwrightState("interrupted")).toBe("failed");
        expect(playwrightTestResult(test as Pick<TestCase, "title" | "titlePath">, result as TestResult)).toEqual({
            suite: "Checkout",
            title: "pays",
            state: "failed",
            durationMs: 30_000,
            error: "Timeout 30000ms exceeded",
            screenshot: "/out/shot.png",
        });
    });
});

describe("e2e project config", () => {
    it("names a bad runner entry and a missing spec folder", () => {
        const bad = () => parseE2eConfig({ id: "shop", runner: { kind: "cypress", config: "c" } }, "/p/e2e.config.ts");
        expect(bad).toThrow("invalid e2e config /p/e2e.config.ts");
        expect(bad).toThrow("at runner.kind");
        expect(bad).toThrow("at specs");
        expect(
            parseE2eConfig(
                { id: "shop", runner: { kind: "wdio", config: "wdio.conf.ts" }, specs: { dir: "specs" } },
                "x"
            ).runner.kind
        ).toBe("wdio");
    });

    it("finds e2e/e2e.config.ts upward and resolves cwd and hooks from the file", async () => {
        const app = join(root, "app");
        mkdirSync(join(app, "e2e", "specs"), { recursive: true });
        const path = join(app, "e2e", "e2e.config.ts");
        writeFileSync(
            path,
            `export default {
                id: "shop",
                cwd: "..",
                runner: { kind: "playwright", config: "playwright.config.ts", baseUrl: "http://127.0.0.1:5173" },
                specs: { dir: "specs" },
                hooks: { beforeRun: () => {} },
            };`
        );

        expect(findE2eConfig(join(app, "e2e", "specs"))).toBe(path);
        const project = await loadE2eProject({ cwd: join(app, "e2e", "specs") });
        expect(project.dir).toBe(join(app, "e2e"));
        expect(project.cwd).toBe(app);
        expect(typeof project.config.hooks?.beforeRun).toBe("function");
        await expect(loadE2eProject({ cwd: root })).rejects.toThrow("pass --config <file>");
    });
});
