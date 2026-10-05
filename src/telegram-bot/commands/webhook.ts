import { join } from "node:path";
import { cloudflaredHome } from "@app/dev-dashboard/lib/tunnel/cloudflared";
import { getStorage, loadTelegramConfig, notConfiguredMessage, saveWebhookUrl } from "@app/telegram-bot/lib/config";
import { createTelegramApi, describeApiError } from "@app/telegram-bot/lib/webhook/api";
import { ensureWebhookSecret, hasWebhookSecret, rotateWebhookSecret } from "@app/telegram-bot/lib/webhook/secret";
import {
    resolveWebhookSettings,
    WEBHOOK_ALLOWED_UPDATES,
    WEBHOOK_RECEIVER_PORT,
    type WebhookSettings,
    WebhookSettingsError,
} from "@app/telegram-bot/lib/webhook/settings";
import { applyTunnelChange, planTunnelChange, readTunnelConfig } from "@app/telegram-bot/lib/webhook/tunnel";
import * as p from "@clack/prompts";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import { captureSync } from "@genesiscz/utils/process/ps";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import type { TelegramBotConfig } from "@genesiscz/utils/telegram-bot/lib/types";
import type { Command } from "commander";

async function requireConfig(): Promise<TelegramBotConfig> {
    const config = await loadTelegramConfig();
    if (!config) {
        p.log.error(notConfiguredMessage());
        process.exit(1);
    }

    return config;
}

/** Under `NETWORKED_LOCK_WAIT_MS`, which a waiting rotation is given while this call holds the config lock. */
const REGISTER_TIMEOUT_MS = 30_000;

function parsePort(value: string | undefined): number | undefined {
    return value === undefined ? undefined : Number(value);
}

function settingsOrExit(input: Parameters<typeof resolveWebhookSettings>[0]): WebhookSettings {
    try {
        return resolveWebhookSettings(input);
    } catch (err) {
        if (err instanceof WebhookSettingsError) {
            p.log.error(err.message);
            process.exit(1);
        }

        throw err;
    }
}

const PRAGUE_TIME = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Prague",
    dateStyle: "short",
    timeStyle: "medium",
});

function pragueTime(unixSeconds: number): string {
    return PRAGUE_TIME.format(new Date(unixSeconds * 1000));
}

async function readConfiguredUrl(): Promise<string | undefined> {
    return getStorage().getConfigValue<string>("webhook.url");
}

function registerStatus(webhook: Command): void {
    webhook
        .command("status")
        .description("Show what Telegram reports for the bot's webhook (read-only)")
        .option("--json", "Print the result as JSON")
        .action(async (opts: { json?: boolean }) => {
            const config = await requireConfig();
            const api = createTelegramApi(config);

            let info: Awaited<ReturnType<typeof api.getWebhookInfo>>;
            try {
                info = await api.getWebhookInfo();
            } catch (err) {
                p.log.error(`Could not read the webhook: ${describeApiError(err, config.botToken)}`);
                process.exit(1);
            }

            const secretStored = await hasWebhookSecret();
            const result = {
                mode: info.url ? "webhook" : "polling",
                url: info.url || null,
                pendingUpdates: info.pending_update_count,
                lastError: info.last_error_message ?? null,
                lastErrorAt: info.last_error_date ? pragueTime(info.last_error_date) : null,
                maxConnections: info.max_connections ?? null,
                ipAddress: info.ip_address ?? null,
                allowedUpdates: info.allowed_updates ?? null,
                configuredUrl: config.webhook?.url ?? null,
                receiverPort: WEBHOOK_RECEIVER_PORT,
                secretStored,
            };

            if (opts.json) {
                out.result(result);
                return;
            }

            out.println(`Mode:             ${result.mode}${info.url ? "" : " (no webhook is set, getUpdates works)"}`);
            out.println(`Webhook URL:      ${result.url ?? "(none)"}`);
            out.println(`Pending updates:  ${result.pendingUpdates}`);
            out.println(
                `Last error:       ${result.lastError ? `${result.lastError} (${result.lastErrorAt}, Europe/Prague)` : "(none)"}`
            );
            out.println(`Allowed updates:  ${result.allowedUpdates?.join(", ") ?? "(Telegram default)"}`);
            out.println(`Configured URL:   ${result.configuredUrl ?? "(none)"}`);
            out.println(`Receiver port:    ${result.receiverPort}`);
            out.println(
                `Secret stored:    ${secretStored ? "yes, in the vault" : "no, the first set or start creates it"}`
            );

            if (info.url && config.webhook?.url && info.url !== config.webhook.url) {
                p.log.warn(
                    "Telegram's URL differs from the configured one. Run the set command to bring them together."
                );
            }
        });
}

function registerSet(webhook: Command): void {
    webhook
        .command("set")
        .description("Tell Telegram to deliver updates to the public URL (turns polling off)")
        .option("--url <url>", "Public https URL; stored in the config for later runs")
        .option(
            "--rotate-secret",
            "Replace the secret; it is stored once Telegram accepts it. Restart the receiver afterwards"
        )
        .action(async (opts: { url?: string; rotateSecret?: boolean }) => {
            const config = await requireConfig();
            const settings = settingsOrExit({ url: opts.url, configuredUrl: config.webhook?.url });
            const api = createTelegramApi(config);
            const unchanged = opts.rotateSecret ? " (the stored secret was not changed)" : "";
            const register = async (secret: string): Promise<void> => {
                try {
                    await api.setWebhook(
                        settings.url,
                        { secret_token: secret, allowed_updates: [...WEBHOOK_ALLOWED_UPDATES] },
                        AbortSignal.timeout(REGISTER_TIMEOUT_MS)
                    );
                } catch (err) {
                    throw new Error(
                        `Telegram refused the webhook: ${describeApiError(err, config.botToken)}${unchanged}`
                    );
                }
            };

            try {
                if (opts.rotateSecret) {
                    await rotateWebhookSecret({ register });
                } else {
                    await register(await ensureWebhookSecret());
                }
            } catch (err) {
                p.log.error(describeApiError(err, config.botToken));
                process.exit(1);
            }

            await saveWebhookUrl(settings.url);
            p.log.success(`Webhook set to ${settings.url}. Telegram stops answering getUpdates until it is deleted.`);
            p.log.info(`Run the receiver: ${toolCommand("telegram-bot start", "--webhook")}`);

            if (opts.rotateSecret) {
                p.log.warn("The secret changed. Restart a running receiver so it picks the new one up.");
            }
        });
}

function registerDelete(webhook: Command): void {
    webhook
        .command("delete")
        .description("Delete the webhook so long-polling works again")
        .action(async () => {
            const config = await requireConfig();
            const api = createTelegramApi(config);

            try {
                await api.deleteWebhook();
            } catch (err) {
                p.log.error(`Telegram refused: ${describeApiError(err, config.botToken)}`);
                process.exit(1);
            }

            p.log.success("Webhook deleted.");
            p.log.info(`Poll again with: ${toolCommand("telegram-bot start")}`);
        });
}

function registerTunnel(webhook: Command): void {
    webhook
        .command("tunnel")
        .description("Point the tunnel's webhook path at the receiver (prints the diff; --apply writes it)")
        .option("--url <url>", "Public https URL; its host and path name the rule (default: the stored one)")
        .option("--port <n>", `Receiver port (default: the registered one, ${WEBHOOK_RECEIVER_PORT})`)
        .option("--config <path>", "cloudflared config file (default: ~/.cloudflared/config.yml)")
        .option("--apply", "Back the file up, write it, validate it and restart the tunnel")
        .action(async (opts: { url?: string; port?: string; config?: string; apply?: boolean }) => {
            const configuredUrl = opts.url ? undefined : await readConfiguredUrl();
            const settings = settingsOrExit({ url: opts.url, configuredUrl, port: parsePort(opts.port) });
            const configPath = opts.config ?? join(cloudflaredHome(), "config.yml");

            let plan: ReturnType<typeof planTunnelChange>;
            try {
                plan = planTunnelChange({
                    configPath,
                    before: readTunnelConfig(configPath),
                    rule: { hostname: settings.hostname, path: settings.path, port: settings.port },
                });
            } catch (err) {
                p.log.error(err instanceof Error ? err.message : String(err));
                process.exit(1);
            }

            if (!plan.changed) {
                p.log.success(
                    `${configPath} already routes ${settings.hostname}${settings.path} to port ${settings.port}.`
                );
                return;
            }

            out.println(plan.diff);

            if (!opts.apply) {
                const again = [
                    ...(opts.url ? ["--url", opts.url] : []),
                    ...(opts.port ? ["--port", opts.port] : []),
                    ...(opts.config ? ["--config", opts.config] : []),
                    "--apply",
                ];
                p.log.info(`Not written. Apply it with: ${toolCommand("telegram-bot webhook tunnel", ...again)}`);
                return;
            }

            try {
                const applied = applyTunnelChange({
                    plan,
                    backupDir: toolDataDir("telegram-bot", "backups"),
                    run: (command, args, options) => captureSync(command, args, options),
                    uid: process.platform === "darwin" ? process.getuid?.() : undefined,
                });
                p.log.success(`Backup: ${applied.backupPath}`);
                p.log.success(
                    applied.restarted
                        ? "Rules written, validated, tunnel restarted."
                        : "Rules written and validated. Restart the tunnel yourself."
                );
            } catch (err) {
                p.log.error(err instanceof Error ? err.message : String(err));
                process.exit(1);
            }
        });
}

export function registerWebhookCommand(program: Command): void {
    const webhook = program.command("webhook").description("Manage the Telegram webhook and its tunnel rule");

    registerStatus(webhook);
    registerSet(webhook);
    registerDelete(webhook);
    registerTunnel(webhook);
}
