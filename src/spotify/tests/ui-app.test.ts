/**
 * The dashboard launcher. Two properties that only show up when someone runs the command, and
 * both were regressions this review found: the port has to come from the config (which reads
 * and validates `SPOTIFY_UI_PORT`), and the bind address has to be loopback.
 */
import { describe, expect, test } from "bun:test";
import { spotifyUiApp } from "@app/spotify/commands/ui";
import { DASHBOARDS } from "@genesiscz/utils/ui/dashboards";

describe("spotify ui launcher", () => {
    const cmd = spotifyUiApp.config.spawn?.cmd ?? [];

    // vite's CLI flag overrides the config file, so passing the registry default here made
    // `SPOTIFY_UI_PORT=4000 tools spotify ui` bind 3075 anyway.
    test("does not pass --port, so the config's env handling decides", () => {
        expect(cmd).not.toContain("--port");
        expect(cmd.some((a) => a === String(DASHBOARDS.spotify.port))).toBe(false);
    });

    test("binds the loopback address from the registry", () => {
        expect(DASHBOARDS.spotify.bindHost).toBe("127.0.0.1");
        expect(cmd[cmd.indexOf("--host") + 1]).toBe("127.0.0.1");
    });

    test("still points at this dashboard's own config", () => {
        expect(cmd.some((a) => a.endsWith("src/spotify/ui/vite.config.ts"))).toBe(true);
        expect(cmd).toContain("--strictPort");
    });
});
