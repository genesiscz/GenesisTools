/**
 * The dashboard door. Same `lib/reports/*` functions as the CLI, reached over HTTP from
 * `ui/routes/api/*` instead of a terminal.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildViteDevCmd, defineDashboardApp } from "@genesiscz/utils/DashboardApp";
import { PROJECT_ROOT } from "@genesiscz/utils/paths";
import { DASHBOARDS } from "@genesiscz/utils/ui/dashboards";
import type { Command } from "commander";

const UI_DIR = resolve(import.meta.dirname, "..", "ui");
const CONFIG_PATH = resolve(UI_DIR, "vite.config.ts");
const VITE_ENTRY = resolve(PROJECT_ROOT, "node_modules", "vite", "bin", "vite.js");

export const spotifyUiApp = defineDashboardApp({
    type: "ui",
    key: "spotify",
    name: "Spotify Listening",
    description: "Launch the Spotify listening dashboard",
    commandName: "ui",
    aliases: ["dashboard"],
    spawn: {
        // No `port` here on purpose: vite's CLI flag overrides the config, so passing the
        // registry default made `SPOTIFY_UI_PORT=4000 tools spotify ui` still bind 3075. The
        // config resolves the environment variable and validates it; this launcher must not
        // reach past that. `--host` stays, and matches what the config binds.
        cmd: buildViteDevCmd({
            configPath: CONFIG_PATH,
            bindHost: DASHBOARDS.spotify.bindHost,
            strictPort: true,
        }),
        cwd: PROJECT_ROOT,
    },
    preflight: async () => {
        if (!existsSync(VITE_ENTRY)) {
            return {
                warnings: [
                    {
                        service: "spotify",
                        error: `Could not find vite at ${VITE_ENTRY}.`,
                        fix: `Run "bun install" in ${PROJECT_ROOT} first.`,
                    },
                ],
            };
        }

        if (!existsSync(CONFIG_PATH)) {
            return { warnings: [{ service: "spotify", error: `Vite config missing: ${CONFIG_PATH}` }] };
        }

        return { warnings: [] };
    },
    readiness: { kind: "http", path: "/", timeoutMs: 90_000 },
    openBrowser: { enabled: true },
    launchd: { available: true },
});

export function registerUiCommand(program: Command): void {
    program.addCommand(spotifyUiApp.commanderCommand);
}
