import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { Storage } from "@genesiscz/utils/storage/storage";
import {
    __resetDashboardConfigStores,
    hiddenFor,
    loadDashboardConfig,
    migrateDashboardConfig,
    prominentFor,
    saveDashboardConfig,
} from "./dashboard-config";

const cleanups: Array<() => void> = [];

function useTempHome(): void {
    const home = mkdtempSync(join(tmpdir(), "ai-usage-dash-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    __resetDashboardConfigStores();
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
}

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }

    env.testing.unset("GENESIS_TOOLS_HOME");
    __resetDashboardConfigStores();
});

describe("loadDashboardConfig", () => {
    test("defaults are per provider", async () => {
        useTempHome();

        const config = await loadDashboardConfig();

        expect(prominentFor(config, "anthropic-sub")).toEqual(["five_hour", "seven_day", "seven_day_sonnet"]);
        expect(prominentFor(config, "openai-sub")).toEqual(["primary", "secondary"]);
        expect(prominentFor(config, "grok-sub")).toEqual(["weekly"]);
        expect(hiddenFor(config, "openai-sub")).toEqual([]);
    });

    test("copies the claude-only store once and reads its flat array as anthropic", async () => {
        useTempHome();
        await new Storage("claude-usage-dashboard").setConfig({
            refreshInterval: 15,
            prominentBuckets: ["five_hour"],
            hiddenBuckets: ["seven_day_opus"],
            hiddenAccounts: ["shop"],
        });

        const config = await loadDashboardConfig();

        expect(config.refreshInterval).toBe(15);
        expect(prominentFor(config, "anthropic-sub")).toEqual(["five_hour"]);
        expect(hiddenFor(config, "anthropic-sub")).toEqual(["seven_day_opus"]);
        expect(config.hiddenAccounts).toEqual(["shop"]);
        // Other providers keep their own defaults rather than inheriting the claude list.
        expect(prominentFor(config, "grok-sub")).toEqual(["weekly"]);

        const copied = await new Storage("ai-usage-dashboard").getConfig<{ refreshInterval: number }>();
        expect(copied?.refreshInterval).toBe(15);
    });

    test("a second load does not overwrite preferences saved in the new store", async () => {
        useTempHome();
        await new Storage("claude-usage-dashboard").setConfig({ refreshInterval: 15 });

        await loadDashboardConfig();
        const saved = await loadDashboardConfig();
        saved.refreshInterval = 90;
        saved.prominentBuckets = { ...saved.prominentBuckets, "openai-sub": ["secondary"] };
        await saveDashboardConfig(saved);

        // The claude-era file still says 15; the copy must not run again.
        const reloaded = await loadDashboardConfig();

        expect(reloaded.refreshInterval).toBe(90);
        expect(prominentFor(reloaded, "openai-sub")).toEqual(["secondary"]);
    });

    test("an old notifications.thresholds config loads into alerts.rules.threshold, field by field", async () => {
        useTempHome();
        await new Storage("ai-usage-dashboard").setConfig({
            notifications: { macos: false, thresholds: { session: [55] } },
        });

        const config = await loadDashboardConfig();

        expect(config.alerts.rules.threshold.session).toEqual([55]);
        expect(config.alerts.rules.threshold.weekly).toEqual([20, 40, 60, 80]);
        expect(config.notifications).toEqual({ enabled: true, inTui: true, macos: false, sound: "Purr" });
    });

    test("the loader writes the moved thresholds back once, and a read-only load writes nothing", async () => {
        useTempHome();
        const storage = new Storage("ai-usage-dashboard");
        await storage.setConfig({ notifications: { thresholds: { weekly: [50] } } });

        await loadDashboardConfig({ readOnly: true });
        expect(await storage.getConfig()).toEqual({ notifications: { thresholds: { weekly: [50] } } });

        await loadDashboardConfig();
        expect(await storage.getConfig()).toEqual({
            notifications: {},
            alerts: { rules: { threshold: { weekly: [50] } } },
        });
    });

    test("migrateDashboardConfig: the new place wins, the old fills gaps, and a second run changes nothing", () => {
        const old = {
            notifications: { sound: "Glass", thresholds: { session: [70], weekly: [10] } },
            alerts: { rules: { threshold: { weekly: [30] } } },
        };
        const first = migrateDashboardConfig(old);

        expect(first.changed).toBe(true);
        expect(first.config).toEqual({
            notifications: { sound: "Glass" },
            alerts: { rules: { threshold: { session: [70], weekly: [30] } } },
        });

        const second = migrateDashboardConfig(first.config);

        expect(second).toEqual({ config: first.config, changed: false });
    });

    test("a new-shape config round-trips unchanged", () => {
        const current = { alerts: { rules: { threshold: { session: [90] } } }, notifications: { enabled: false } };

        expect(migrateDashboardConfig(current)).toEqual({ config: current, changed: false });
    });
    // Every load must be detached from the module constants. A caller that edits what it
    // got back used to edit DEFAULTS, and the next load in the process inherited it.
    test("a mutated config does not leak into the next load", async () => {
        useTempHome();

        const first = await loadDashboardConfig();
        first.hiddenAccounts.push("work");
        first.alerts.rules.threshold.weekly.push(99);
        prominentFor(first, "anthropic-sub").push("invented");

        const second = await loadDashboardConfig();

        expect(second.hiddenAccounts).toEqual([]);
        expect(second.alerts.rules.threshold.weekly).toEqual([20, 40, 60, 80]);
        expect(prominentFor(second, "anthropic-sub")).toEqual(["five_hour", "seven_day", "seven_day_sonnet"]);
    });

    test("a saved config is detached from the defaults too", async () => {
        useTempHome();
        await new Storage("ai-usage-dashboard").setConfig({ refreshInterval: 90 });

        const first = await loadDashboardConfig();
        first.alerts.rules.threshold.session.push(99);

        expect((await loadDashboardConfig()).alerts.rules.threshold.session).toEqual([80]);
    });
});
