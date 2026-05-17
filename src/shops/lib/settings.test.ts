import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsRepository } from "@app/shops/lib/settings";
import { SafeJSON } from "@app/utils/json";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shops-settings-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("SettingsRepository (per-user)", () => {
    it("returns defaults when no file exists", async () => {
        const repo = new SettingsRepository(join(dir, "settings"));
        const settings = await repo.read(1);
        expect(settings.default_landing_view).toBe("/watchlist");
        expect(settings.theme).toBe("cyberpunk");
        expect(settings.notification_channels.macos).toBe(true);
        expect(settings.notification_channels.web_sse).toBe(true);
        expect(settings.notification_channels.telegram).toBe(false);
        expect(settings.default_cooldown_hours).toBe(24);
        expect(settings.http_requests_retention_days).toBe(30);
        expect(settings.shops).toEqual({});
    });

    it("persists a partial patch and reads it back, scoped to the user", async () => {
        const repo = new SettingsRepository(join(dir, "settings"));
        await repo.patch(1, { theme: "wow", default_cooldown_hours: 6 });
        const settings1 = await repo.read(1);
        expect(settings1.theme).toBe("wow");
        expect(settings1.default_cooldown_hours).toBe(6);
        const settings2 = await repo.read(2);
        expect(settings2.theme).toBe("cyberpunk");
    });

    it("user A's patch does NOT leak to user B", async () => {
        const repo = new SettingsRepository(join(dir, "settings"));
        await repo.patch(1, { default_cooldown_hours: 99 });
        await repo.patch(2, { default_cooldown_hours: 7 });
        expect((await repo.read(1)).default_cooldown_hours).toBe(99);
        expect((await repo.read(2)).default_cooldown_hours).toBe(7);
    });

    it("merges nested notification_channels patch without dropping siblings", async () => {
        const repo = new SettingsRepository(join(dir, "settings"));
        await repo.patch(1, {
            notification_channels: {
                macos: false,
                web_sse: true,
                telegram: true,
                telegram_bot_token: "BOT_TOKEN_REDACTED",
                telegram_chat_id: "12345",
            },
        });
        const settings = await repo.read(1);
        expect(settings.notification_channels.macos).toBe(false);
        expect(settings.notification_channels.telegram).toBe(true);
        expect(settings.notification_channels.telegram_bot_token).toBe("BOT_TOKEN_REDACTED");
    });

    it("merges per-shop entries without clobbering others", async () => {
        const repo = new SettingsRepository(join(dir, "settings"));
        await repo.patch(1, { shops: { "rohlik.cz": { rate_limit_per_second: 1, enabled: true } } });
        await repo.patch(1, { shops: { "kosik.cz": { rate_limit_per_second: 2, enabled: false } } });
        const settings = await repo.read(1);
        expect(settings.shops["rohlik.cz"]).toEqual({ rate_limit_per_second: 1, enabled: true });
        expect(settings.shops["kosik.cz"]).toEqual({ rate_limit_per_second: 2, enabled: false });
    });

    it("rejects an unknown default_landing_view", async () => {
        const repo = new SettingsRepository(join(dir, "settings"));
        await expect(
            repo.patch(1, { default_landing_view: "/bogus" } as unknown as Parameters<typeof repo.patch>[1])
        ).rejects.toThrow("default_landing_view");
    });

    it("rejects negative cooldown_hours", async () => {
        const repo = new SettingsRepository(join(dir, "settings"));
        await expect(repo.patch(1, { default_cooldown_hours: -3 })).rejects.toThrow("default_cooldown_hours");
    });

    it("redacts telegram_bot_token in toLogString()", async () => {
        const repo = new SettingsRepository(join(dir, "settings"));
        await repo.patch(1, {
            notification_channels: {
                macos: true,
                web_sse: true,
                telegram: true,
                telegram_bot_token: "1234567890:AAH-fakeBOTTOKEN",
                telegram_chat_id: "99999",
            },
        });
        const out = repo.toLogString(await repo.read(1));
        expect(out).not.toContain("AAH-fakeBOTTOKEN");
        expect(out).toContain("REDACTED");
    });

    it("survives concurrent patches via the per-instance per-user write queue", async () => {
        const repo = new SettingsRepository(join(dir, "settings"));
        await Promise.all([
            repo.patch(1, { default_cooldown_hours: 1 }),
            repo.patch(1, { default_cooldown_hours: 2 }),
            repo.patch(1, { default_cooldown_hours: 3 }),
        ]);
        const settings = await repo.read(1);
        expect([1, 2, 3]).toContain(settings.default_cooldown_hours);
    });

    it("migrates legacy ../config.json to settings/1.json on first read for user 1", async () => {
        const baseDir = join(dir, "settings");
        const legacy = join(dir, "config.json");
        writeFileSync(legacy, SafeJSON.stringify({ default_cooldown_hours: 42, theme: "wow" }), "utf8");
        const repo = new SettingsRepository(baseDir);
        const settings = await repo.read(1);
        expect(settings.default_cooldown_hours).toBe(42);
        expect(settings.theme).toBe("wow");
    });
});
