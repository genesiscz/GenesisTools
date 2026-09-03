import { resolve } from "node:path";
import { defineDashboardApp } from "@genesiscz/utils/DashboardApp";
import { PROJECT_ROOT } from "@genesiscz/utils/paths";
import { WEB_SERVICES } from "@genesiscz/utils/ui/dashboards";

const SERVER_ENTRY = resolve(PROJECT_ROOT, "src/monitor/lib/server/index.ts");

export const monitorServerApp = defineDashboardApp({
    type: "server",
    key: "monitor-server",
    name: "Monitor server",
    description: "Run the watcher scheduler + API server",
    commandName: "server",
    port: WEB_SERVICES["monitor-server"].port,
    spawn: {
        cmd: ["bun", "run", SERVER_ENTRY],
        cwd: PROJECT_ROOT,
    },
    readiness: { kind: "http", path: "/api/v1/healthz" },
    launchd: { available: true, label: "com.genesis-tools.monitor-server" },
});
