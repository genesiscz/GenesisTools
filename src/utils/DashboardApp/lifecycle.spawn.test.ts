import { describe, expect, it } from "bun:test";
import { buildCommanderCommand } from "./commander";
import { buildLifecycleContext } from "./lifecycle";
import { launchdSpawnCmd, persistInstallServeMode, resolveSpawnCmd } from "./lifecycle-serve";
import type { DashboardAppConfig } from "./types";

const config = {
    type: "ui",
    key: "spawn-test",
    description: "test",
    commandName: "ui",
    spawn: { cmd: ["bun", "x", "__ui-server", "--static"], devCmd: ["bun", "x", "__ui-server", "--dev"] },
} satisfies DashboardAppConfig;

const previewConfig = {
    ...config,
    spawn: { ...config.spawn, previewCmd: ["bun", "x", "__ui-server"] },
    launchd: { available: true },
} satisfies DashboardAppConfig;

describe("resolveSpawnCmd", () => {
    it("defaults to the built bundle and picks the dev and preview commands by mode", () => {
        expect(resolveSpawnCmd(config)).toEqual(config.spawn.cmd);
        expect(resolveSpawnCmd(config, { uiServe: "dev" })).toEqual(config.spawn.devCmd);
        expect(resolveSpawnCmd(previewConfig, { uiServe: "preview" })).toEqual(["bun", "x", "__ui-server"]);
    });

    it("falls back to the built bundle when the dashboard defines no preview command", () => {
        expect(resolveSpawnCmd(config, { uiServe: "preview" })).toEqual(config.spawn.cmd);
    });
});

describe("install --preview", () => {
    it("is remembered for later launchd spawns, and a plain install clears it", () => {
        const key = `serve-preview-${crypto.randomUUID()}`;
        const withPreview = { ...previewConfig, key };

        persistInstallServeMode(key, true);
        expect(launchdSpawnCmd(withPreview, {})).toEqual(["bun", "x", "__ui-server"]);

        persistInstallServeMode(key, false);
        expect(launchdSpawnCmd(withPreview, {})).toEqual(config.spawn.cmd);
    });

    it("registers --preview on install and keeps --dev on up for HMR", () => {
        const cmd = buildCommanderCommand({
            config: previewConfig,
            ctx: buildLifecycleContext(previewConfig, 1),
        });
        const installFlags = cmd.commands.find((c) => c.name() === "install")?.options.map((o) => o.long) ?? [];
        const upFlags = cmd.commands.find((c) => c.name() === "up")?.options.map((o) => o.long) ?? [];

        expect(installFlags).toContain("--preview");
        expect(installFlags).not.toContain("--dev");
        expect(upFlags).toContain("--dev");
        expect(cmd.commands.some((c) => c.name() === "dev")).toBe(true);
    });
});
