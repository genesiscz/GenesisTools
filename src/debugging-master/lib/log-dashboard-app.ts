import { resolve } from "node:path";
import { defineDashboardApp } from "@app/utils/DashboardApp";
import { PROJECT_ROOT } from "@app/utils/paths";
import { DASHBOARDS } from "@app/utils/ui/dashboards";

const SERVER_ENTRY = resolve(import.meta.dirname, "log-dashboard-server.ts");

export const logDashboardApp = defineDashboardApp({
    type: "server",
    key: "debugging-master",
    name: DASHBOARDS["debugging-master"].name,
    description: "Unified dbg + task log dashboard HTTP server",
    commandName: "serve",
    port: DASHBOARDS["debugging-master"].port,
    bindHost: DASHBOARDS["debugging-master"].bindHost,
    spawn: {
        cmd: ["bun", "run", SERVER_ENTRY],
        cwd: PROJECT_ROOT,
        env: { LOG_DASHBOARD_PORT: String(DASHBOARDS["debugging-master"].port) },
    },
    access: {
        qr: { small: true },
        label: "dashboard",
    },
    readiness: { kind: "http", path: "/health" },
    open: {
        preflight: async () => {
            const { ensureDashboardBuilt } = await import("../commands/dashboard");
            await ensureDashboardBuilt();
        },
        serveHint: {
            tool: "tools debugging-master",
            replaceCommand: ["dashboard", "serve"],
        },
    },
    launchd: { available: true, label: "com.genesis-tools.log-dashboard" },
});
