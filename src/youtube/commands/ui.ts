import { resolve } from "node:path";
import { PROJECT_ROOT } from "@app/utils/paths";
import { spawnDashboard } from "@app/utils/process/spawnDashboard";
import { DASHBOARDS } from "@app/utils/ui/dashboards";
import { getYoutube } from "@app/youtube/commands/_shared/ensure-pipeline";
import type { Command } from "commander";

export function registerUiCommand(program: Command): void {
    const cmd = program.command("ui").description("Launch the YouTube web UI");

    cmd.command("start", { isDefault: true })
        .description("Start the YouTube web UI dev server")
        .option(
            "--port <n>",
            `Vite dev server port (default ${DASHBOARDS.youtube.port})`,
            (value) => Number.parseInt(value, 10),
            DASHBOARDS.youtube.port
        )
        .option("--api-url <url>", "Override the API base URL written to server.json on first run")
        .action(async (opts: { port: number; apiUrl?: string }) => {
            const yt = await getYoutube();
            if (opts.apiUrl) {
                await yt.config.update({ apiBaseUrl: opts.apiUrl, firstRunComplete: true });
            }

            const uiDir = resolve(import.meta.dirname, "..", "ui");
            setTimeout(() => openBrowser(`http://localhost:${opts.port}`), 2000);
            await spawnDashboard({
                cmd: [
                    "bun",
                    "--bun",
                    "vite",
                    "dev",
                    "-c",
                    resolve(uiDir, "vite.config.ts"),
                    "--port",
                    String(opts.port),
                    "--strictPort",
                ],
                cwd: PROJECT_ROOT,
                env: { YOUTUBE_PROJECT_CWD: process.cwd() },
            });
        });
}

function openBrowser(url: string): void {
    if (process.platform === "darwin") {
        Bun.spawn(["open", url]);
        return;
    }

    if (process.platform === "win32") {
        Bun.spawn(["cmd", "/c", "start", url]);
        return;
    }

    Bun.spawn(["xdg-open", url]);
}
