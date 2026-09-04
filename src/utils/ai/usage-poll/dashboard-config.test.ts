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
        expect(prominentFor(config, "openai-sub")).toEqual(["primary"]);
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

    test("notification thresholds merge field by field", async () => {
        useTempHome();
        await new Storage("ai-usage-dashboard").setConfig({
            notifications: { thresholds: { session: [55] } },
        });

        const config = await loadDashboardConfig();

        expect(config.notifications.thresholds.session).toEqual([55]);
        expect(config.notifications.thresholds.weekly).toEqual([20, 40, 60, 80]);
        expect(config.notifications.enabled).toBe(true);
    });
});
