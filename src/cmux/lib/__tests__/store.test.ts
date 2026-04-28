import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileExistsError, ProfileNotFoundError, ProfileStore } from "@app/cmux/lib/store";
import { PROFILE_VERSION, type Profile } from "@app/cmux/lib/types";

const sampleProfile: Profile = {
    version: PROFILE_VERSION,
    name: "demo",
    scope: "all",
    captured_at: "2026-04-27T15:00:00.000Z",
    cmux_version: "0.63.2",
    note: "test fixture",
    windows: [
        {
            ref: "window:1",
            title: "Main",
            container_frame: { width: 3193, height: 1378 },
            workspaces: [
                {
                    ref: "workspace:1",
                    title: "alpha",
                    selected: true,
                    panes: [
                        {
                            ref: "pane:1",
                            index: 0,
                            columns: 199,
                            rows: 79,
                            pixel_frame: { x: 0, y: 0, width: 1597, height: 1378 },
                            selected_surface_index: 0,
                            surfaces: [{ type: "terminal", title: "alpha-1" }],
                        },
                    ],
                },
            ],
        },
    ],
};

let tempDir: string;
let store: ProfileStore;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cmux-store-test-"));
    store = new ProfileStore({ profilesDir: tempDir });
});

afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

describe("ProfileStore", () => {
    it("round-trips a profile through write + read", () => {
        store.write("demo", sampleProfile);
        const read = store.read("demo");
        expect(read.name).toBe("demo");
        expect(read.windows).toHaveLength(1);
        expect(read.windows[0].workspaces[0].panes[0].surfaces).toHaveLength(1);
    });

    it("rejects duplicate writes without --force", () => {
        store.write("demo", sampleProfile);
        expect(() => store.write("demo", sampleProfile)).toThrow(ProfileExistsError);
        expect(() => store.write("demo", sampleProfile, { force: true })).not.toThrow();
    });

    it("rejects unsafe profile names", () => {
        expect(() => store.pathFor("../escape")).toThrow();
        expect(() => store.pathFor("with/slash")).toThrow();
        expect(() => store.pathFor("with space")).toThrow();
        expect(store.pathFor("safe.dot_under-dash")).toContain("safe.dot_under-dash.json");
    });

    it("returns ProfileNotFoundError for missing names", () => {
        expect(() => store.read("does-not-exist")).toThrow(ProfileNotFoundError);
    });

    it("lists profiles in name-sorted order", () => {
        store.write("zeta", { ...sampleProfile, name: "zeta" });
        store.write("alpha", { ...sampleProfile, name: "alpha" });
        store.write("beta", { ...sampleProfile, name: "beta" });
        const summaries = store.list();
        expect(summaries.map((s) => s.name)).toEqual(["alpha", "beta", "zeta"]);
    });

    it("delete returns true on hit, false on miss", () => {
        store.write("demo", sampleProfile);
        expect(store.delete("demo")).toBe(true);
        expect(store.delete("demo")).toBe(false);
    });

    it("summarize counts windows/workspaces/panes/surfaces", () => {
        store.write("demo", sampleProfile);
        const summary = store.summarize(sampleProfile);
        expect(summary.windows).toBe(1);
        expect(summary.workspaces).toBe(1);
        expect(summary.panes).toBe(1);
        expect(summary.surfaces).toBe(1);
        expect(summary.bytes).toBeGreaterThan(0);
    });
});
