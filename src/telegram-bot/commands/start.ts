import { createBot } from "@app/telegram-bot/lib/bot";
import { loadTelegramConfig, notConfiguredMessage, saveWebhookUrl } from "@app/telegram-bot/lib/config";
import { COMMANDS } from "@app/telegram-bot/lib/handlers/help";
import { createTelegramApi, describeApiError } from "@app/telegram-bot/lib/webhook/api";
import { ensureWebhookSecret } from "@app/telegram-bot/lib/webhook/secret";
import { runWebhookService } from "@app/telegram-bot/lib/webhook/service";
import { resolveApiRoot, resolveWebhookSettings, WebhookSettingsError } from "@app/telegram-bot/lib/webhook/settings";
import * as p from "@clack/prompts";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { TelegramBotConfig } from "@genesiscz/utils/telegram-bot/lib/types";
import type { Command } from "commander";

interface StartOptions {
    webhook?: boolean;
    url?: string;
    port?: string;
    path?: string;
    deleteOnExit?: boolean;
}

async function startPolling(config: TelegramBotConfig): Promise<void> {
    const bot = createBot(config.botToken, config.chatId, { apiRoot: resolveApiRoot(config.apiRoot) });

    const me = await bot.api.getMe();
    p.log.success(`Starting bot @${me.username ?? me.first_name} (Ctrl+C to stop)`);

    await bot.api.setMyCommands(COMMANDS);

    let pollCount = 0;
    const timeout = 30;
    // bot.start() deletes any webhook before it polls: Telegram allows a webhook or getUpdates, never both.
    await bot.start({
        timeout,
        onStart: () => {
            pollCount++;
            p.log.info(`Polling started (long-polling, ${timeout}s timeout, run #${pollCount})`);
        },
    });
}

async function startWebhook(config: TelegramBotConfig, opts: StartOptions): Promise<void> {
    const settings = resolveWebhookSettings({
        url: opts.url,
        configuredUrl: config.webhook?.url,
        path: opts.path,
        port: opts.port === undefined ? undefined : Number(opts.port),
    });
    const secret = await ensureWebhookSecret();
    await saveWebhookUrl(settings.url);

    const bot = createBot(config.botToken, config.chatId, { apiRoot: resolveApiRoot(config.apiRoot) });
    await bot.init();
    await bot.api.setMyCommands(COMMANDS);
    p.log.success(`Starting webhook receiver for @${bot.botInfo.username} (Ctrl+C to stop)`);

    await withInterrupt(async (interrupt) => {
        const stop = new AbortController();
        const onTerminate = () => stop.abort();
        process.once("SIGTERM", onTerminate);
        interrupt.addEventListener("abort", onTerminate, { once: true });

        try {
            await runWebhookService({
                bot,
                api: createTelegramApi(config),
                secret,
                settings,
                deleteOnExit: opts.deleteOnExit === true,
                signal: stop.signal,
                onListening: (server) => p.log.info(`Receiver listening on 127.0.0.1:${server.port}${settings.path}`),
            });
        } finally {
            process.off("SIGTERM", onTerminate);
        }
    });

    p.log.info(
        opts.deleteOnExit
            ? "Receiver stopped, webhook deleted."
            : "Receiver stopped. The webhook stays set, so Telegram keeps the updates and retries them."
    );
}

export function registerStartCommand(program: Command): void {
    program
        .command("start")
        .description("Start the interactive bot (long-polling, or --webhook)")
        .option("--webhook", "Receive updates through the public tunnel instead of polling")
        .option("--url <url>", "Public https URL Telegram delivers to; stored (needs --webhook)")
        .option("--port <n>", "Local receiver port, default is the registered one (needs --webhook)")
        .option("--path <path>", "Receiver path, equal to the path of the public URL (needs --webhook)")
        .option("--delete-on-exit", "Delete the webhook when the receiver stops (needs --webhook)")
        .action(async (opts: StartOptions) => {
            const config = await loadTelegramConfig();
            if (!config) {
                p.log.error(notConfiguredMessage());
                process.exit(1);
            }

            if (!opts.webhook) {
                if (opts.url || opts.port || opts.path || opts.deleteOnExit) {
                    p.log.error(`These options need --webhook. Run: ${toolCommand("telegram-bot start", "--webhook")}`);
                    process.exit(1);
                }

                await startPolling(config);
                return;
            }

            try {
                await startWebhook(config, opts);
            } catch (err) {
                if (err instanceof WebhookSettingsError) {
                    p.log.error(err.message);
                } else {
                    p.log.error(`Webhook receiver failed: ${describeApiError(err, config.botToken)}`);
                }

                process.exit(1);
            }
        });
}
