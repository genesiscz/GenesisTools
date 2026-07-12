#!/usr/bin/env bun

import { runAccountsList, runAccountsRemove, runAccountsTest } from "@app/ai-proxy/commands/accounts";
import { runAccountsLogin } from "@app/ai-proxy/commands/accounts-login";
import { clientsAdd, clientsList, clientsUsage } from "@app/ai-proxy/commands/clients";
import { runConfigDetect, runConfigInit, runConfigSet, runConfigShow } from "@app/ai-proxy/commands/config";
import { runConfigMenu, runSetupCloudflaredTunnel } from "@app/ai-proxy/commands/config-wizard";
import { runDownCommand } from "@app/ai-proxy/commands/down";
import { runUpdateModelsCommand } from "@app/ai-proxy/commands/internal/update-models";
import { runIntrospectCommand } from "@app/ai-proxy/commands/introspect";
import { runModelsCommand } from "@app/ai-proxy/commands/models";
import { runServeCommand } from "@app/ai-proxy/commands/serve";
import { runStatusCommand } from "@app/ai-proxy/commands/status";
import { runUpCommand } from "@app/ai-proxy/commands/up";
import { runUsageCommand } from "@app/ai-proxy/commands/usage";
import { isValidThinkingMode } from "@app/ai-proxy/lib/thinking-config";
import type { AiProxyProviderType, CursorTranslationMode, ThinkingPresentationMode } from "@app/ai-proxy/lib/types";
import { runTool } from "@app/utils/cli";
import { Command } from "commander";

const program = new Command()
    .name("ai-proxy")
    .description("OpenAI-compatible local proxy for Grok, GitHub Copilot, and other AI providers")
    .version("0.1.0");

program
    .command("up")
    .description("Start ai-proxy (and optional public exposure tunnel)")
    .action(async () => {
        await runUpCommand();
    });

program
    .command("down")
    .description("Stop ai-proxy only (never stops shared cloudflared tunnel)")
    .action(async () => {
        await runDownCommand();
    });

program
    .command("status")
    .description("Show ai-proxy and public exposure status")
    .option("--json", "Machine-readable output")
    .action(async (options) => {
        await runStatusCommand(options);
    });

program
    .command("serve")
    .description("Start the OpenAI-compatible proxy server")
    .option("--port <number>", "Listen port", (value) => Number.parseInt(value, 10))
    .option("--host <host>", "Listen host")
    .option("--translate-cursor <mode>", "Cursor translation mode: auto|on|off")
    .option("--thinking <mode>", "Thinking presentation: raw|cursor|folded")
    .option("--no-translate", "Disable Cursor translation")
    .action(async (options) => {
        const thinking =
            options.thinking && isValidThinkingMode(options.thinking)
                ? (options.thinking as ThinkingPresentationMode)
                : undefined;

        await runServeCommand({
            port: options.port,
            host: options.host,
            translateCursor: options.translateCursor as CursorTranslationMode | undefined,
            thinking,
            noTranslate: options.noTranslate,
        });
    });

program
    .command("models")
    .description("List proxy model ids and metadata")
    .option("--provider <slug>", "Filter by provider slug")
    .option("--visibility <tier>", "Filter by visibility: high|medium|low")
    .option("--json", "Machine-readable output")
    .option("--cursor-ids", "Print only proxy ids")
    .action(async (options) => {
        await runModelsCommand(options);
    });

const clientsCmd = program.command("clients").description("Manage per-user client keys + usage ledger");

clientsCmd
    .command("list")
    .description("List configured clients (keys masked)")
    .action(async () => {
        await clientsList();
    });

clientsCmd
    .command("add <name>")
    .description("Add a client; prints its generated key ONCE")
    .option("--token-cap <n>", "Monthly total-token cap", (v) => Number.parseInt(v, 10))
    .option("--cost-cap <usd>", "Monthly cost cap in USD", (v) => Number.parseFloat(v))
    .option("--provider <type...>", "Restrict to provider types (never subscription types)")
    .action(async (name: string, opts: { tokenCap?: number; costCap?: number; provider?: string[] }) => {
        await clientsAdd({
            name,
            tokenCap: opts.tokenCap,
            costCap: opts.costCap,
            providers: opts.provider as AiProxyProviderType[] | undefined,
        });
    });

clientsCmd
    .command("usage")
    .description("Per-client monthly usage (JSON, or CSV for invoicing)")
    .option("--month <YYYY-MM>", "Month to report (default: current UTC month)")
    .option("--csv", "CSV output")
    .action(async (opts: { month?: string; csv?: boolean }) => {
        await clientsUsage(opts);
    });

program
    .command("introspect")
    .alias("ls")
    .description("Print full copy-paste inventory for Cursor BYOK")
    .option("--json", "Machine-readable output")
    .option("--show-secrets", "Include full proxy API key in output")
    .option("--clipboard", "Copy output to clipboard")
    .option("--section <name>", "accounts|endpoints|models|cursor|all")
    .option("--account <name>", "Limit to one account")
    .action(async (options) => {
        await runIntrospectCommand(options);
    });

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
    .action(async () => {
        await runConfigInit();
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

program
    .command("usage")
    .description("Show subscription or Management API usage")
    .option("--account <name>", "Limit to one account")
    .option("--json", "Machine-readable output")
    .option("--recent <n>", "Include last N local request records", (value) => Number.parseInt(value, 10))
    .option("--paths", "Print local usage store file paths")
    .action(async (options) => {
        await runUsageCommand(options);
    });

const accountsCmd = program.command("accounts").description("Manage configured accounts");

accountsCmd
    .command("login <provider>")
    .description("OAuth login for a provider (github-copilot)")
    .action(async (provider: string) => {
        await runAccountsLogin(provider);
    });

accountsCmd
    .command("list")
    .description("List configured accounts")
    .action(async () => {
        await runAccountsList();
    });

accountsCmd
    .command("test <name>")
    .description("Ping upstream for an account")
    .action(async (name: string) => {
        await runAccountsTest(name);
    });

accountsCmd
    .command("remove <name>")
    .description("Remove an account from config")
    .action(async (name: string) => {
        await runAccountsRemove(name);
    });

const internalCmd = program.command("internal").description("Internal maintenance commands").showHelpAfterError();

internalCmd
    .command("update-models")
    .description("Probe upstream models and write data/models-catalog.json")
    .option("--account <name>", "Limit to one account")
    .option("--provider <slug>", "Filter by provider slug (grok, github-copilot)")
    .option("--dry-run", "Print would-be catalog without writing")
    .option("--no-probe", "Picker catalog only")
    .action(async (options) => {
        await runUpdateModelsCommand(options);
    });

await runTool(program, { tool: "ai-proxy" });
