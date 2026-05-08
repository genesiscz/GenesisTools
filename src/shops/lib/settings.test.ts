import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsRepository } from "./settings";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shops-settings-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("SettingsRepository", () => {
    it("returns defaults when no file exists", async () => {
        const repo = new SettingsRepository(join(dir, "config.json"));
        const settings = await repo.read();
        expect(settings.default_landing_view).toBe("/watchlist");
        expect(settings.theme).toBe("cyberpunk");
        expect(settings.notification_channels.macos).toBe(true);
        expect(settings.notification_channels.web_sse).toBe(true);
        expect(settings.notification_channels.telegram).toBe(false);
        expect(settings.default_cooldown_hours).toBe(24);
        expect(settings.http_requests_retention_days).toBe(30);
        expect(settings.shops).toEqual({});
    });

    it("persists a partial patch and reads it back", async () => {
        const repo = new SettingsRepository(join(dir, "config.json"));
        await repo.patch({ theme: "wow", default_cooldown_hours: 6 });
        const settings = await repo.read();
        expect(settings.theme).toBe("wow");
        expect(settings.default_cooldown_hours).toBe(6);
        expect(settings.default_landing_view).toBe("/watchlist");
    });

    it("merges nested notification_channels patch without dropping siblings", async () => {
        const repo = new SettingsRepository(join(dir, "config.json"));
        await repo.patch({
            notification_channels: {
                macos: false,
                web_sse: true,
                telegram: true,
                telegram_bot_token: "BOT_TOKEN_REDACTED",
                telegram_chat_id: "12345",
            },
        });
        const settings = await repo.read();
        expect(settings.notification_channels.macos).toBe(false);
        expect(settings.notification_channels.telegram).toBe(true);
        expect(settings.notification_channels.telegram_bot_token).toBe("BOT_TOKEN_REDACTED");
    });

    it("merges per-shop entries without clobbering others", async () => {
        const repo = new SettingsRepository(join(dir, "config.json"));
        await repo.patch({ shops: { "rohlik.cz": { rate_limit_per_second: 1, enabled: true } } });
        await repo.patch({ shops: { "kosik.cz": { rate_limit_per_second: 2, enabled: false } } });
        const settings = await repo.read();
        expect(settings.shops["rohlik.cz"]).toEqual({ rate_limit_per_second: 1, enabled: true });
        expect(settings.shops["kosik.cz"]).toEqual({ rate_limit_per_second: 2, enabled: false });
    });

    it("rejects an unknown default_landing_view", async () => {
        const repo = new SettingsRepository(join(dir, "config.json"));
        await expect(
            repo.patch({ default_landing_view: "/bogus" } as unknown as Parameters<typeof repo.patch>[0]),
        ).rejects.toThrow("default_landing_view");
    });

    it("rejects negative cooldown_hours", async () => {
        const repo = new SettingsRepository(join(dir, "config.json"));
        await expect(repo.patch({ default_cooldown_hours: -3 })).rejects.toThrow("default_cooldown_hours");
    });

    it("redacts telegram_bot_token in toLogString()", async () => {
        const repo = new SettingsRepository(join(dir, "config.json"));
        await repo.patch({
            notification_channels: {
                macos: true,
                web_sse: true,
                telegram: true,
                telegram_bot_token: "1234567890:AAH-fakeBOTTOKEN",
                telegram_chat_id: "99999",
            },
        });
        const out = repo.toLogString(await repo.read());
        expect(out).not.toContain("AAH-fakeBOTTOKEN");
        expect(out).toContain("REDACTED");
    });

    it("survives concurrent patches via the per-instance write queue", async () => {
        const repo = new SettingsRepository(join(dir, "config.json"));
        await Promise.all([
            repo.patch({ default_cooldown_hours: 1 }),
            repo.patch({ default_cooldown_hours: 2 }),
            repo.patch({ default_cooldown_hours: 3 }),
        ]);
        const settings = await repo.read();
        expect([1, 2, 3]).toContain(settings.default_cooldown_hours);
    });
});
