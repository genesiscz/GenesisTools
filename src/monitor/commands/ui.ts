import { resolve } from "node:path";
import { monitorServerApp } from "@app/monitor/lib/server/app";
import { buildViteDevCmd, defineDashboardApp } from "@genesiscz/utils/DashboardApp";
import { PROJECT_ROOT } from "@genesiscz/utils/paths";
import { DASHBOARDS } from "@genesiscz/utils/ui/dashboards";
import type { Command } from "commander";

const CONFIG_PATH = resolve(import.meta.dirname, "..", "ui", "vite.config.ts");

export const monitorUiApp = defineDashboardApp({
    type: "ui",
    key: "monitor",
    name: "Monitor",
    description: "Launch the Monitor dashboard",
    commandName: "ui",
    spawn: {
        cmd: buildViteDevCmd({
            configPath: CONFIG_PATH,
            port: DASHBOARDS.monitor.port,
            strictPort: true,
        }),
        cwd: PROJECT_ROOT,
    },
    dependencies: [{ app: monitorServerApp, policy: "prompt" }],
    readiness: { kind: "http", path: "/", timeoutMs: 90_000 },
    openBrowser: { enabled: true },
    launchd: { available: true },
});

export function registerUiCommand(program: Command): void {
    program.addCommand(monitorUiApp.commanderCommand);
}
