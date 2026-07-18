import { resolve } from "node:path";
import { buildViteDevCmd, defineDashboardApp } from "@genesiscz/utils/DashboardApp";
import { PROJECT_ROOT } from "@genesiscz/utils/paths";

const reasUiConfigPath = resolve(import.meta.dir, "../ui/vite.config.ts");

export const reasUiApp = defineDashboardApp({
    type: "ui",
    key: "reas",
    name: "REAS Analyzer",
    description: "Launch the REAS Analyzer dashboard",
    commandName: "ui",
    aliases: ["dashboard"],
    spawn: {
        cmd: buildViteDevCmd({ configPath: reasUiConfigPath, strictPort: true }),
        cwd: PROJECT_ROOT,
    },
    readiness: { kind: "http", path: "/" },
    openBrowser: { enabled: true },
    launchd: { available: true },
});
