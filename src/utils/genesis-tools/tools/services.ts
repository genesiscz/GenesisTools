import { toolCommand } from "@genesiscz/utils/cli/tool-command";

/**
 * The commands that start a GenesisTools dashboard or local service, named by the port registry in
 * `src/utils/ui/dashboards.ts` and by the DashboardApp launcher. This file imports `toolCommand()` and nothing else,
 * so the registry loads no logger, commander or process helper.
 */

/** Serves the artifact kit gallery without opening a browser or registering the folder. */
export function artifactKitGalleryCommand(): string {
    return toolCommand("artifact serve kit-gallery --no-open --no-register");
}

/** Starts the one server for every registered artifact folder. */
export function artifactLibraryUpCommand(): string {
    return toolCommand("artifact library up");
}

/** Starts the Jev workbench dashboard. */
export function jevDashboardCommand(): string {
    return toolCommand("jev dashboard");
}

/** Starts the Claude history dashboard. */
export function claudeHistoryDashboardCommand(): string {
    return toolCommand("claude history dashboard");
}

/** Starts the tasks, timers and focus dashboard. */
export function dashboardCommand(): string {
    return toolCommand("dashboard");
}

/** Starts the dev dashboard (vault, terminal, cmux). */
export function devDashboardCommand(): string {
    return toolCommand("dev-dashboard");
}

/** Starts the Clarity timesheet sync dashboard. */
export function clarityUiCommand(): string {
    return toolCommand("clarity ui");
}

/** Starts the real-estate analysis dashboard. */
export function reasDashboardCommand(): string {
    return `${toolCommand("internal reas")} --dashboard`;
}

/** Starts the e-shop price dashboard. */
export function shopsUiCommand(): string {
    return toolCommand("shops ui");
}

/** Starts the YouTube dashboard. */
export function youtubeUiCommand(): string {
    return toolCommand("youtube ui");
}

/** Starts the Spotify listening dashboard. */
export function spotifyUiCommand(): string {
    return toolCommand("spotify ui");
}

/** Starts the uptime monitor dashboard. */
export function monitorUiCommand(): string {
    return toolCommand("monitor ui");
}

/** Serves the live log dashboard of debugging-master and task sessions. */
export function debuggingMasterDashboardServeCommand(): string {
    return toolCommand("debugging-master dashboard serve");
}

/** Opens the task sessions in the shared log dashboard. */
export function taskDashboardOpenCommand(): string {
    return toolCommand("task dashboard open");
}

/** Opens the shared log dashboard through its DashboardApp launcher. */
export function debuggingMasterDashboardServeOpenCommand(): string {
    return toolCommand("debugging-master dashboard serve open");
}

/** Starts the managed-tier cloud dashboard. */
export function devDashboardCloudCommand(): string {
    return toolCommand("dev-dashboard-cloud");
}

/** Starts the YouTube backend API. */
export function youtubeServerCommand(): string {
    return toolCommand("youtube server");
}

/** Starts the YouTube extension's dev reload bridge. */
export function youtubeExtensionDevCommand(): string {
    return toolCommand("youtube extension dev");
}

/** The uptime monitor tool itself. */
export function monitorCommand(): string {
    return toolCommand("monitor");
}

/** Starts the uptime monitor's scheduler and API server. */
export function monitorServerUpCommand(): string {
    return toolCommand("monitor server up");
}

/** Starts the local AI proxy. */
export function aiProxyServeCommand(): string {
    return toolCommand("ai-proxy serve");
}

/** Starts the MCP gateway, the loopback proxy that owns upstream OAuth. */
export function mcpManagerGatewayStartCommand(): string {
    return toolCommand("mcp-manager gateway start");
}

/** Starts the Telegram bot's webhook receiver. */
export function telegramBotWebhookStartCommand(): string {
    return toolCommand("telegram-bot start", "--webhook");
}

/** Points the public tunnel's webhook rule at the Telegram bot. */
export function telegramBotWebhookTunnelCommand(): string {
    return toolCommand("telegram-bot webhook tunnel");
}

/** Logs an MCP server in through its pre-registered OAuth app. */
export function mcpManagerAuthLoginCommand(): string {
    return toolCommand("mcp-manager auth login");
}

/** Tails the log of a DashboardApp started in the background: `<key>` and `<commandName>` from its config. */
export function dashboardAppAttachCommand(key: string, commandName: string): string {
    return toolCommand(`${key} ${commandName} attach`);
}

/** Starts a DashboardApp dependency that is not running, named by its subcommand alone as the prompt prints it. */
export function dashboardAppDependencyUpCommand(commandName: string): string {
    return toolCommand(`${commandName} up`);
}
