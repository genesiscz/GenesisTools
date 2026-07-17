import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeConfig } from "@app/youtube/lib/config";

let dir: string;
let config: YoutubeConfig;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yt-config-foundations-"));
    config = new YoutubeConfig({ baseDir: dir });
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("config foundations (powerUsers / ai / referrals)", () => {
    it("defaults to empty powerUsers, empty ai, disabled referrals", async () => {
        const all = await config.getAll();

        expect(all.powerUsers).toEqual([]);
        expect(all.ai).toEqual([]);
        expect(all.referrals).toEqual({ enabled: false, offers: [] });
    });

    it("round-trips ai mappings and powerUsers through update()", async () => {
        await config.update({
            powerUsers: [{ email: "boss@example.com", type: "admin" }],
            ai: [
                { provider: "xai", model: "grok-4-fast-reasoning", for: ["insights", "summary"] },
                { provider: "xai", model: "grok-4-fast-non-reasoning", for: ["all"] },
            ],
        });
        const fresh = new YoutubeConfig({ baseDir: dir });
        const all = await fresh.getAll();

        expect(all.powerUsers).toEqual([{ email: "boss@example.com", type: "admin" }]);
        expect(all.ai).toHaveLength(2);
        expect(all.ai[1].for).toEqual(["all"]);
    });

    it("replaces arrays wholesale on patch (no element merge)", async () => {
        await config.update({ powerUsers: [{ email: "a@example.com", type: "dev" }] });
        await config.update({ powerUsers: [{ email: "b@example.com", type: "admin" }] });
        const all = await config.getAll();

        expect(all.powerUsers).toEqual([{ email: "b@example.com", type: "admin" }]);
    });

    it("merges referrals shallowly with offers replaced wholesale", async () => {
        await config.update({
            referrals: {
                enabled: true,
                offers: [{ from: "2026-07-01T00:00:00Z", to: "2026-08-01T00:00:00Z", reward: 25 }],
            },
        });
        await config.update({ referrals: { enabled: false } });
        const all = await config.getAll();

        expect(all.referrals.enabled).toBe(false);
        expect(all.referrals.offers).toHaveLength(1);
    });
});

describe("config freeTier (Phase 2)", () => {
    it("defaults to disabled metering", async () => {
        const all = await config.getAll();

        expect(all.freeTier).toEqual({ actionsPerMonth: null });
    });

    it("round-trips a configured monthly limit", async () => {
        await config.update({ freeTier: { actionsPerMonth: 20 } });
        const fresh = new YoutubeConfig({ baseDir: dir });

        expect((await fresh.getAll()).freeTier.actionsPerMonth).toBe(20);
    });
});
