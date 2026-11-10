import { loadTelegramConfig, saveTelegramConfig } from "@app/telegram-bot/lib/config";
import { WEBHOOK_ALLOWED_UPDATES } from "@app/telegram-bot/lib/webhook/settings";
import * as p from "@genesiscz/utils/prompts/p";
import { createApi, describeApiError, TELEGRAM_REQUEST_TIMEOUT_SECONDS } from "@genesiscz/utils/telegram-bot/lib/api";
import type { Command } from "commander";

/** One long poll for the first message must end inside the client's request timeout, or the client aborts it. */
const FIRST_MESSAGE_POLL_SECONDS = TELEGRAM_REQUEST_TIMEOUT_SECONDS - 2;
/** About three minutes of waiting for the first message. */
const FIRST_MESSAGE_POLLS = Math.ceil(180 / FIRST_MESSAGE_POLL_SECONDS);

export function registerConfigureCommand(program: Command): void {
    program
        .command("configure")
        .description("Set up Telegram Bot for notifications")
        .action(async () => {
            p.intro("telegram-bot configure");

            const existing = await loadTelegramConfig();
            if (existing) {
                p.log.info(`Already configured: @${existing.botUsername ?? "bot"} (chat ${existing.chats.commands})`);
                const overwrite = await p.confirm({
                    message: "Are you sure you want to overwrite the current configuration?",
                    cancel: "back",
                });
                if (p.isCancel(overwrite) || !overwrite) {
                    p.outro("Keeping existing configuration.");
                    return;
                }
            }

            p.note(
                "1. Open Telegram and search for @BotFather\n" +
                    "2. Send /newbot and follow the prompts\n" +
                    "3. Copy the API token BotFather gives you",
                "Setup Instructions"
            );

            const token = await p.text({
                message: "Paste your bot token:",
                placeholder: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
                validate: (val) => {
                    if (!val || !/^\d+:[A-Za-z0-9_-]+$/.test(val)) {
                        return "Invalid token format (expected: 123456:ABC...)";
                    }
                },
                cancel: "back",
            });
            if (p.isCancel(token)) {
                return;
            }

            // A self-hosted Bot API root from the config being replaced stays: the new token is checked there and kept.
            const apiRoot = existing?.apiRoot;
            const api = createApi(token as string, apiRoot);
            let botUsername: string;
            try {
                const me = await api.getMe();
                botUsername = me.username ?? me.first_name;
                p.log.success(`Connected to bot: @${botUsername}`);
            } catch (err) {
                p.log.error(`Invalid token: ${describeApiError(err, token as string)}`);
                return;
            }

            await api.deleteWebhook();

            // Flush stale updates so we only detect fresh messages
            let nextOffset: number | undefined;
            for (;;) {
                const stale = await api.getUpdates({ offset: nextOffset ?? -1, timeout: 0 });
                if (stale.length === 0) {
                    break;
                }
                nextOffset = stale[stale.length - 1].update_id + 1;
            }

            p.log.step("Now send any message to your bot in Telegram...");
            const spinner = p.spinner();
            spinner.start("Waiting for your message...");

            let chatId: number | null = null;
            for (let attempt = 0; attempt < FIRST_MESSAGE_POLLS; attempt++) {
                try {
                    const updates = await api.getUpdates({
                        offset: nextOffset,
                        timeout: FIRST_MESSAGE_POLL_SECONDS,
                        // The full list: Telegram keeps the last list it was given, and a ["message"] here once
                        // kept every later button press from arriving.
                        allowed_updates: [...WEBHOOK_ALLOWED_UPDATES],
                    });
                    const lastMessage = updates.findLast((update) => update.message)?.message;
                    if (lastMessage) {
                        chatId = lastMessage.chat.id;
                        break;
                    }

                    if (updates.length > 0) {
                        nextOffset = updates[updates.length - 1].update_id + 1;
                    }
                } catch {
                    // Retry on poll errors
                }
            }

            if (!chatId) {
                spinner.stop("Timed out waiting for message");
                p.log.error("Could not detect your chat ID. Please try again.");
                return;
            }

            spinner.stop(`Chat ID detected: ${chatId}`);

            await saveTelegramConfig({
                botToken: token as string,
                chats: { commands: chatId },
                botUsername,
                configuredAt: new Date().toISOString(),
                ...(apiRoot ? { apiRoot } : {}),
            });

            try {
                await api.sendMessage(chatId, "GenesisTools telegram-bot configured successfully!");
                p.log.success("Test message sent");
            } catch (err) {
                p.log.warn(`Could not send test message: ${describeApiError(err, token as string)}`);
            }

            p.outro("Configuration complete!");
        });
}
