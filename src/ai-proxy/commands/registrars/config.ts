import { runConfigDetect, runConfigInit, runConfigSet, runConfigShow } from "@app/ai-proxy/commands/config";
import { runConfigMenu, runSetupCloudflaredTunnel } from "@app/ai-proxy/commands/config-wizard";
import type { Command } from "commander";

export function register(program: Command): void {
    const configCmd = program
        .command("config")
        .description("Manage ai-proxy config (interactive menu when run without subcommand)")
        .action(async () => {
            await runConfigMenu();
        });

    configCmd
        .command("setup-tunnel")
        .description("Interactive cloudflared tunnel setup for Cursor (public URL)")
        .action(async () => {
            await runSetupCloudflaredTunnel();
        });

    configCmd
        .command("detect")
        .description("Detect local Grok, GitHub Copilot, and API keys")
        .action(async () => {
            await runConfigDetect();
        });

    configCmd
        .command("init")
        .description("Initialize config from detected accounts")
        .option("--append", "Add detected providers the config has no account for, leaving existing accounts untouched")
        .action(async (options: { append?: boolean }) => {
            await runConfigInit(options);
        });

    configCmd
        .command("show")
        .description("Show current config (redacted)")
        .action(async () => {
            await runConfigShow();
        });

    configCmd
        .command("set")
        .description("Update config values")
        .option("--port <number>", "Listen port", (value) => Number.parseInt(value, 10))
        .option("--proxy-key <key>", "Proxy API key")
        .option("--translate <mode>", "Cursor translation mode")
        .option("--thinking <mode>", "Thinking presentation: raw|cursor|folded")
        .option("--public-hostname <host>", "Public hostname for Cursor, e.g. proxy.example.dev")
        .option("--public-base-path <path>", "URL prefix on hostname, e.g. /ai")
        .option("--exposure-mode <mode>", "none|cloudflared|tailscale|custom")
        .option("--public-base-url <url>", "Custom Cursor base URL (…/v1) when mode=custom")
        .option("--tunnel-name <name>", "cloudflared tunnel name")
        .option("--cloudflared-config <path>", "Path to cloudflared config.yml")
        .option("--cloudflared-auto-start <bool>", "Start tunnel on up (true|false)")
        .action(async (options) => {
            await runConfigSet({
                port: options.port,
                proxyKey: options.proxyKey,
                translate: options.translate,
                thinking: options.thinking,
                publicHostname: options.publicHostname,
                publicBasePath: options.publicBasePath,
                exposureMode: options.exposureMode,
                publicBaseUrl: options.publicBaseUrl,
                tunnelName: options.tunnelName,
                cloudflaredConfigPath: options.cloudflaredConfig,
                cloudflaredAutoStart:
                    options.cloudflaredAutoStart === undefined ? undefined : options.cloudflaredAutoStart === "true",
            });
        });
}
