import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDashboardUiServerCmd, defineDashboardApp } from "@genesiscz/utils/DashboardApp";
import { PROJECT_ROOT } from "@genesiscz/utils/paths";

const serverScript = resolve(fileURLToPath(new URL("../index.ts", import.meta.url)));

/**
 * DashboardApp harness config. `up` and `install` run the static server (one build, then serve);
 * `install --dev` registers the watch build instead (rebuild on save, page reload), and `ui dev`
 * swaps in Vite dev + HMR for one run and brings the installed server back on exit.
 */
export const devDashboardUiApp = defineDashboardApp({
    type: "ui",
    key: "dev-dashboard",
    name: "Dev Dashboard",
    description: "Launch dev-dashboard (front-proxy, UI built once and served, ttyd)",
    commandName: "ui",
    aliases: ["dashboard"],
    bindHost: "0.0.0.0",
    spawn: {
        cmd: buildDashboardUiServerCmd({ serverScript, mode: "static" }),
        devCmd: buildDashboardUiServerCmd({ serverScript, mode: "dev" }),
        previewCmd: buildDashboardUiServerCmd({ serverScript, mode: "preview" }),
        cwd: PROJECT_ROOT,
    },
    readiness: { kind: "http", path: "/", timeoutMs: 90_000 },
    openBrowser: { enabled: false },
    launchd: { available: true },
});
