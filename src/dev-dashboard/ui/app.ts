import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDashboardUiServerCmd, defineDashboardApp } from "@app/utils/DashboardApp";
import { PROJECT_ROOT } from "@app/utils/paths";

const serverScript = resolve(fileURLToPath(new URL("../index.ts", import.meta.url)));

/** DashboardApp harness config — preview (watch build) is the default serve mode. */
export const devDashboardUiApp = defineDashboardApp({
    type: "ui",
    key: "dev-dashboard",
    name: "Dev Dashboard",
    description: "Launch dev-dashboard (front-proxy, bundled UI with watch rebuild, ttyd)",
    commandName: "ui",
    aliases: ["dashboard"],
    bindHost: "0.0.0.0",
    spawn: {
        cmd: buildDashboardUiServerCmd({ serverScript, mode: "preview" }),
        devCmd: buildDashboardUiServerCmd({ serverScript, mode: "dev" }),
        cwd: PROJECT_ROOT,
    },
    readiness: { kind: "http", path: "/", timeoutMs: 90_000 },
    openBrowser: { enabled: false },
    launchd: { available: true },
});
