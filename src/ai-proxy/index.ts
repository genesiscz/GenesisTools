#!/usr/bin/env bun

import {
    type AccountsRoutingPatch,
    runAccountsAllowEnv,
    runAccountsList,
    runAccountsRemove,
    runAccountsSetEnabled,
    runAccountsSetKey,
    runAccountsSetRouting,
    runAccountsStatus,
    runAccountsTest,
} from "@app/ai-proxy/commands/accounts";
import { runAccountsLogin } from "@app/ai-proxy/commands/accounts-login";
import { runCallsCommand } from "@app/ai-proxy/commands/calls";
import { clientsAdd, clientsList, clientsSecure, clientsUsage } from "@app/ai-proxy/commands/clients";
import { runConfigDetect, runConfigInit, runConfigSet, runConfigShow } from "@app/ai-proxy/commands/config";
import { runConfigMenu, runSetupCloudflaredTunnel } from "@app/ai-proxy/commands/config-wizard";
import { runDownCommand } from "@app/ai-proxy/commands/down";
import { runUpdateModelsCommand } from "@app/ai-proxy/commands/internal/update-models";
import { runIntrospectCommand } from "@app/ai-proxy/commands/introspect";
import { runLinkCommand } from "@app/ai-proxy/commands/link";
import { runModelsCommand } from "@app/ai-proxy/commands/models";
import { runServeCommand } from "@app/ai-proxy/commands/serve";
import { runStatusCommand } from "@app/ai-proxy/commands/status";
import { runUpCommand } from "@app/ai-proxy/commands/up";
import { runUsageCommand } from "@app/ai-proxy/commands/usage";
import { registerAiProxyRefScanner } from "@app/ai-proxy/lib/account-refs";
import { loadConfigFresh } from "@app/ai-proxy/lib/config";
import { isValidThinkingMode } from "@app/ai-proxy/lib/thinking-config";
import type { AiProxyProviderType, CursorTranslationMode, ThinkingPresentationMode } from "@app/ai-proxy/lib/types";
import { setProxyUsageSink } from "@app/ai-proxy/lib/usage/usage-events";
import { recordUsage } from "@genesiscz/utils/ai/usage";
import { runTool } from "@genesiscz/utils/cli";
import { configureLogger } from "@genesiscz/utils/logger";
import { Command } from "commander";

// proxy.log is the serve process's stderr — without timestamps a stale log
// file is indistinguishable from a quiet one, which is exactly how a 5-day-old
// proxy.log derailed an incident investigation. Must run before runTool: its
// setBaseBinding() instantiates the logger, freezing timestamp options.
if (process.argv.includes("serve")) {
    configureLogger({ includeTimestamp: true, timestampFormat: "SYS:yyyy-mm-dd HH:MM:ss" });
}

// So `referrersOf` sees the accounts this proxy bills. The scanner is per
// PROCESS, so `tools ai config link` needs the same one line in its own
// entrypoint to see proxy links (src/ai/ is another phase's file).
registerAiProxyRefScanner(loadConfigFresh);

// Mirror the ledger's bookings into the shared usage layer. `recordUsage` never
// throws, so a failure here cannot break a proxied request. A booked cost is
// stored verbatim (the invoicing table is a deliberate carve-out and its rates
// may differ from the catalog's); an unpriced row gets a catalog estimate
// tagged `costSource: "catalog"`, which keeps "the invoicing table did not know
// this model" answerable instead of hiding it behind a list price.
setProxyUsageSink((event) => void recordUsage(event));

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

program
    .command("calls")
    .description("Query proxied calls (session/stage/label/model/slow) and open full transcripts")
    .option("--session <id>", "Filter by x-gt-session (substring)")
    .option("--stage <name>", "Filter by x-gt-stage (exact)")
    .option("--label <text>", "Filter by x-gt-label (substring)")
    .option("--model <text>", "Filter by proxy model id (substring)")
    .option("--slower-than <secs>", "Only calls at least this slow", Number.parseFloat)
    .option("--since <minutes>", "Only calls from the last N minutes", Number.parseFloat)
    .option("--limit <n>", "Max rows (newest kept)", "40")
    .option("--show", "Print the full prompt + response of each match")
    .option("--timeline", "Show per-call phase breakdown (dispatch, TTFB, thinking, text)")
    .option("--json", "Machine-readable output")
    .action(
        (options: {
            session?: string;
            stage?: string;
            label?: string;
            model?: string;
            slowerThan?: number;
            since?: number;
            limit: string;
            show?: boolean;
            timeline?: boolean;
            json?: boolean;
        }) => {
            runCallsCommand({
                session: options.session,
                stage: options.stage,
                label: options.label,
                model: options.model,
                slowerThan: options.slowerThan,
                sinceMinutes: options.since,
                limit: Number(options.limit),
                show: options.show,
                timeline: options.timeline,
                json: options.json,
            });
        }
    );

program
    .command("link")
    .description("Register this proxy as an AI-config account so @proxy/<slug>/<model> refs resolve")
    .option("--status", "Report the link without changing anything")
    .action(async (options: { status?: boolean }) => {
        await runLinkCommand(options);
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
    .command("secure")
    .description("Move plaintext client keys into the vault (config keeps only a reference)")
    .action(async () => {
        await clientsSecure();
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

program
    .command("usage")
    .description("Show subscription or Management API usage")
    .option("--account <name>", "Limit to one account")
    .option("--provider <type>", "Filter by provider type or slug (e.g. openai-subscription, codex)")
    .option("--json", "Machine-readable output")
    .option("--recent <n>", "Include last N local request records", (value) => Number.parseInt(value, 10))
    .option("--breakdown", "Per-model aggregates over the trailing 30 days")
    .option("--paths", "Print local usage store file paths")
    .action(async (options) => {
        await runUsageCommand(options);
    });

function parseCsvOption(value?: string): string[] | undefined {
    if (!value) {
        return undefined;
    }

    const items = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

    return items.length > 0 ? items : undefined;
}

const accountsCmd = program.command("accounts").description("Manage configured accounts");

accountsCmd
    .command("login <provider>")
    .description("OAuth login for a provider (github-copilot, codex)")
    .action(async (provider: string) => {
        await runAccountsLogin(provider);
    });

accountsCmd
    .command("status")
    .description("Auth detail for codex accounts (source, expiry, plan)")
    .action(async () => {
        await runAccountsStatus();
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
    .command("disable <name>")
    .description("Disable an account (kept in config, skipped at runtime)")
    .action(async (name: string) => {
        await runAccountsSetEnabled(name, false);
    });

accountsCmd
    .command("enable <name>")
    .description("Re-enable a disabled account")
    .action(async (name: string) => {
        await runAccountsSetEnabled(name, true);
    });

accountsCmd
    .command("set-key <name> [key]")
    .description("Choose an api-key account's credential (omit key for a masked interactive chooser)")
    .action(async (name: string, key?: string) => {
        await runAccountsSetKey(name, key);
    });

accountsCmd
    .command("allow-env <name>")
    .description("Non-interactive form of set-key's env choice (clears any stored key; --off revokes)")
    .option("--off", "revoke the opt-in")
    .option("--env <NAME>", "Read the key from this env var instead of the provider's default name")
    .action(async (name: string, options: { off?: boolean; env?: string }) => {
        await runAccountsAllowEnv(name, !options.off, { envName: options.env });
    });

accountsCmd
    .command("set-routing <name>")
    .description("Pin an OpenRouter account's provider routing (order/only/ignore/sort/fallbacks)")
    .option(
        "--match <glob>",
        "Scope to one per-model route instead of the account-level default (exact id or a trailing *)"
    )
    .option("--order <providers>", "Comma-separated provider names, most preferred first")
    .option("--only <providers>", "Comma-separated provider names — route ONLY to these")
    .option("--ignore <providers>", "Comma-separated provider names to never route to")
    .option("--sort <mode>", "price|throughput|latency", (value: string) => {
        if (value !== "price" && value !== "throughput" && value !== "latency") {
            throw new Error(`--sort must be price, throughput, or latency (got "${value}")`);
        }

        return value;
    })
    .option("--allow-fallbacks", "Allow OpenRouter to fall back beyond the pinned/allowed providers")
    .option("--no-allow-fallbacks", "Refuse fallback — only the pinned/allowed providers may serve the request")
    .option("--require-parameters", "Only route to providers supporting every parameter in the request")
    .option("--no-require-parameters", "Allow providers that silently drop unsupported parameters")
    .option("--data-collection <mode>", "allow|deny", (value: string) => {
        if (value !== "allow" && value !== "deny") {
            throw new Error(`--data-collection must be allow or deny (got "${value}")`);
        }

        return value;
    })
    .option("--fallback-models <ids>", "Comma-separated OpenRouter model ids to try if the primary one fails")
    .option("--clear", "Remove all provider-routing pins for this account")
    .action(
        async (
            name: string,
            options: {
                match?: string;
                order?: string;
                only?: string;
                ignore?: string;
                sort?: "price" | "throughput" | "latency";
                allowFallbacks?: boolean;
                requireParameters?: boolean;
                dataCollection?: "allow" | "deny";
                fallbackModels?: string;
                clear?: boolean;
            },
            command: Command
        ) => {
            const patch: AccountsRoutingPatch = {
                order: parseCsvOption(options.order),
                only: parseCsvOption(options.only),
                ignore: parseCsvOption(options.ignore),
                sort: options.sort,
                allowFallbacks:
                    command.getOptionValueSource("allowFallbacks") === "cli" ? options.allowFallbacks : undefined,
                requireParameters:
                    command.getOptionValueSource("requireParameters") === "cli" ? options.requireParameters : undefined,
                dataCollection: options.dataCollection,
                fallbackModels: parseCsvOption(options.fallbackModels),
            };

            await runAccountsSetRouting(name, patch, { clear: options.clear, match: options.match });
        }
    );

accountsCmd
    .command("remove <name>")
    .description("Remove an account from config")
    .action(async (name: string) => {
        await runAccountsRemove(name);
    });

const internalCmd = program.command("internal").description("Internal maintenance commands").showHelpAfterError();

internalCmd
    .command("update-models")
    .description("Probe upstream models and write ~/.genesis-tools/ai-proxy/models-catalog.json")
    .option("--account <name>", "Limit to one account")
    .option("--provider <slug>", "Filter by provider slug (grok, github-copilot)")
    .option("--dry-run", "Print would-be catalog without writing")
    .option("--no-probe", "Picker catalog only")
    .action(async (options) => {
        await runUpdateModelsCommand(options);
    });

await runTool(program, { tool: "ai-proxy" });
