import type { TmuxPresetSummary } from "@dd/contract";
import { beforeAll, describe, expect, it } from "bun:test";
import { fixtureDashboardClient, setFixtureLatency } from "@/api/fixture-wire";
import {
    capturePreset,
    deletePreset,
    presetsQuery,
    restorePreset,
    TMUX_PRESETS_INTERVAL_MS,
    tmuxPresetsKeys,
} from "@/features/tmux-presets/queries";

/**
 * Proves the tmux-presets data layer flows through the typed `client.presets.*` seam WITHOUT a React
 * renderer — we exercise the mock client + the `presetsQuery` factory's `queryFn` directly (exactly
 * what `useQuery` calls). The mock is STATEFUL (capture appends, delete removes), which is what makes
 * the Appium "capture adds a row" / "delete drops a row" assertions trustworthy. Mirrors
 * features/reminders-todos/queries.test.ts + features/containers/queries.test.ts.
 */

beforeAll(() => setFixtureLatency(0));

describe("mock dashboard client — presets", () => {
    it("presets.list() returns a { presets } array of well-formed summaries", async () => {
        const { presets } = await fixtureDashboardClient.presets.list();
        expect(Array.isArray(presets)).toBe(true);
        expect(presets.length).toBeGreaterThan(0);

        for (const preset of presets) {
            expect(typeof preset.name).toBe("string");
            expect(typeof preset.capturedAt).toBe("string");
            expect(typeof preset.sessions).toBe("number");
            expect(typeof preset.windows).toBe("number");
            expect(typeof preset.panes).toBe("number");
            expect(typeof preset.bytes).toBe("number");
        }
    });

    it("presets.save({ name }) returns a { preset } with the saved name AND the new row appears in a subsequent list", async () => {
        const name = `unit-${Date.now()}`;
        const before = (await fixtureDashboardClient.presets.list()).presets.length;

        const { preset } = await fixtureDashboardClient.presets.save({ name });
        expect(preset.name).toBe(name);

        const after = await fixtureDashboardClient.presets.list();
        expect(after.presets.length).toBe(before + 1);
        expect(after.presets.some((p) => p.name === name)).toBe(true);
    });

    it("presets.remove(name) returns { removed: true } AND drops the row from a subsequent list (stateful mock)", async () => {
        const name = `unit-del-${Date.now()}`;
        await fixtureDashboardClient.presets.save({ name });
        expect((await fixtureDashboardClient.presets.list()).presets.some((p) => p.name === name)).toBe(true);

        const res = await fixtureDashboardClient.presets.remove(name);
        expect(res.removed).toBe(true);

        const after = await fixtureDashboardClient.presets.list();
        expect(after.presets.some((p) => p.name === name)).toBe(false);
    });

    it("presets.restore(name) returns a { result } with created/skipped/failed counts", async () => {
        const { result } = await fixtureDashboardClient.presets.restore("morning-dev");
        expect(result.name).toBe("morning-dev");
        expect(typeof result.created).toBe("number");
        expect(typeof result.skipped).toBe("number");
        expect(typeof result.failed).toBe("number");
    });
});

describe("tmux-presets query factory", () => {
    it("presetsQuery builds the list key + interval + a queryFn returning a TmuxPresetSummary[]", async () => {
        const opts = presetsQuery(fixtureDashboardClient);
        expect([...opts.queryKey]).toEqual([...tmuxPresetsKeys.list]);
        expect(opts.queryKey[0]).toBe("tmux-presets");
        expect(opts.refetchInterval).toBe(TMUX_PRESETS_INTERVAL_MS);
        expect(typeof opts.queryFn).toBe("function");

        const data = await (opts.queryFn as unknown as () => Promise<TmuxPresetSummary[]>)();
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBeGreaterThan(0);
    });
});

describe("tmux-presets mutation callers", () => {
    it("capturePreset(client, { name }) resolves to { preset }", async () => {
        const res = await capturePreset(fixtureDashboardClient, { name: `via-caller-${Date.now()}` });
        expect(typeof res.preset.name).toBe("string");
    });

    it("restorePreset(client, name) resolves to { result }", async () => {
        const res = await restorePreset(fixtureDashboardClient, "release");
        expect(res.result.name).toBe("release");
    });

    it("deletePreset(client, name) resolves to { removed }", async () => {
        const name = `caller-del-${Date.now()}`;
        await capturePreset(fixtureDashboardClient, { name });
        const res = await deletePreset(fixtureDashboardClient, name);
        expect(res.removed).toBe(true);
    });
});
