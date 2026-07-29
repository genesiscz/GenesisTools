import { resolve } from "node:path";
import { collectConfiguredProviderEnv } from "@genesiscz/utils/ai/provider-env";
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
        // The summarize / qa / cloud-transcribe stages resolve their provider
        // from an API-key env var. Under launchd the agent gets a bare
        // environment, so a key exported from the shell profile never arrives
        // and every job dies with `Could not resolve provider="xai"` — snapshot
        // whatever is configured when the plist is written.
        env: collectConfiguredProviderEnv(),
    },
    readiness: { kind: "http", path: "/api/v1/jobs?limit=1" },
    launchd: { available: true, label: "com.genesis-tools.youtube-server" },
});
