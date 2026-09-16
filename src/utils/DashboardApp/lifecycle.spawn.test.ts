import { describe, expect, it } from "bun:test";
import { resolveSpawnCmd } from "./lifecycle";
import type { DashboardAppConfig } from "./types";

const config = {
    type: "ui",
    key: "spawn-test",
    description: "test",
    commandName: "ui",
    spawn: { cmd: ["bun", "x", "__ui-server", "--static"], devCmd: ["bun", "x", "__ui-server", "--dev"] },
} satisfies DashboardAppConfig;

describe("resolveSpawnCmd", () => {
    it("defaults to the built bundle and picks the dev and preview commands by mode", () => {
        expect(resolveSpawnCmd(config)).toEqual(config.spawn.cmd);
        expect(resolveSpawnCmd(config, { uiServe: "dev" })).toEqual(config.spawn.devCmd);
        expect(
            resolveSpawnCmd(
                { ...config, spawn: { ...config.spawn, previewCmd: ["bun", "x", "__ui-server"] } },
                { uiServe: "preview" }
            )
        ).toEqual(["bun", "x", "__ui-server"]);
    });

    it("falls back to the built bundle when the dashboard defines no preview command", () => {
        expect(resolveSpawnCmd(config, { uiServe: "preview" })).toEqual(config.spawn.cmd);
    });
});
