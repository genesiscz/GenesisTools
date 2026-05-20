import { describe, expect, test } from "bun:test";
import { shouldOpenBrowser } from "./lifecycle";
import type { DashboardAppConfig } from "./types";

function uiConfig(enabled: boolean): DashboardAppConfig {
    return {
        type: "ui",
        key: "test",
        description: "test",
        commandName: "ui",
        openBrowser: { enabled },
        spawn: { cmd: ["true"] },
    };
}

describe("shouldOpenBrowser", () => {
    test("honors openBrowser.enabled when commander defaults open to true", () => {
        expect(shouldOpenBrowser(uiConfig(false), { open: true })).toBe(false);
        expect(shouldOpenBrowser(uiConfig(true), { open: true })).toBe(true);
    });

    test("--no-open suppresses even when app enables auto-open", () => {
        expect(shouldOpenBrowser(uiConfig(true), { open: false })).toBe(false);
    });

    test("defaults to false when openBrowser is unset", () => {
        const config: DashboardAppConfig = {
            type: "ui",
            key: "test",
            description: "test",
            commandName: "ui",
            spawn: { cmd: ["true"] },
        };

        expect(shouldOpenBrowser(config, { open: true })).toBe(false);
    });
});
