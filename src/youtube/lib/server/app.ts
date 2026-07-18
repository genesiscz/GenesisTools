import { resolve } from "node:path";
import { defineDashboardApp } from "@genesiscz/utils/DashboardApp";
import { PROJECT_ROOT } from "@genesiscz/utils/paths";

const SERVER_ENTRY = resolve(PROJECT_ROOT, "src/youtube/lib/server/index.ts");

export const youtubeServerApp = defineDashboardApp({
    type: "server",
    key: "youtube-server",
    name: "YouTube AI API server",
    description: "Run the YouTube AI background API server",
    commandName: "server",
    port: 9876,
    spawn: {
        cmd: ["bun", "run", SERVER_ENTRY],
        cwd: PROJECT_ROOT,
    },
    readiness: { kind: "http", path: "/api/v1/jobs?limit=1" },
    launchd: { available: true, label: "com.genesis-tools.youtube-server" },
});
