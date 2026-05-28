import { resolve } from "node:path";
import { buildViteDevCmd, defineDashboardApp } from "@app/utils/DashboardApp";
import { PROJECT_ROOT } from "@app/utils/paths";
import { DASHBOARDS } from "@app/utils/ui/dashboards";
import { getYoutube } from "@app/youtube/commands/_shared/ensure-pipeline";
import { youtubeServerApp } from "@app/youtube/lib/server/app";
import type { Command } from "commander";

const UI_DIR = resolve(import.meta.dirname, "..", "ui");
const CONFIG_PATH = resolve(UI_DIR, "vite.config.ts");

const API_URL_OPTION = "--api-url <url>";
const API_URL_DESC = "Override the API base URL written to server.json on first run";

export const youtubeUiApp = defineDashboardApp({
    type: "ui",
    key: "youtube",
    name: "YouTube AI",
    description: "Launch the YouTube AI web UI",
    commandName: "ui",
    spawn: {
        cmd: buildViteDevCmd({
            configPath: CONFIG_PATH,
            port: DASHBOARDS.youtube.port,
            strictPort: true,
        }),
        cwd: PROJECT_ROOT,
        env: { YOUTUBE_PROJECT_CWD: process.cwd() },
    },
    dependencies: [{ app: youtubeServerApp, policy: "prompt" }],
    readiness: { kind: "http", path: "/", timeoutMs: 90_000 },
    openBrowser: { enabled: true },
    launchd: { available: true },
});

async function applyApiUrlOverride(command: Command): Promise<void> {
    const opts = command.opts() as { apiUrl?: string };

    if (opts.apiUrl) {
        const yt = await getYoutube();
        await yt.config.update({ apiBaseUrl: opts.apiUrl, firstRunComplete: true });
    }
}

function wireApiUrlOption(command: Command): void {
    command.option(API_URL_OPTION, API_URL_DESC);
    command.hook("preAction", async (thisCommand) => {
        await applyApiUrlOverride(thisCommand);
    });
}

export function registerUiCommand(program: Command): void {
    const cmd = youtubeUiApp.commanderCommand;

    wireApiUrlOption(cmd);

    for (const name of ["up", "restart"]) {
        const sub = cmd.commands.find((c) => c.name() === name);

        if (sub) {
            wireApiUrlOption(sub);
        }
    }

    program.addCommand(cmd);
}
