import { loadTelegramConfig, saveTelegramConfig } from "@app/telegram-bot/lib/config";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { Api } from "grammy";

export function registerConfigureCommand(program: Command): void {
    program
        .command("configure")
        .description("Set up Telegram Bot for notifications")
        .action(async () => {
            p.intro("telegram-bot configure");

            const existing = await loadTelegramConfig();
            if (existing) {
                p.log.info(`Already configured: @${existing.botUsername ?? "bot"} (chat ${existing.chatId})`);
                const overwrite = await p.confirm({
                    message: "Are you sure you want to overwrite the current configuration?",
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
            });
            if (p.isCancel(token)) {
                return;
            }

            const api = new Api(token as string);
            let botUsername: string;
            try {
                const me = await api.getMe();
                botUsername = me.username ?? me.first_name;
                p.log.success(`Connected to bot: @${botUsername}`);
            } catch (err) {
                p.log.error(`Invalid token: ${(err as Error).message}`);
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
            for (let attempt = 0; attempt < 6; attempt++) {
                try {
                    const updates = await api.getUpdates({
                        offset: nextOffset,
                        timeout: 30,
                        allowed_updates: ["message"],
                    });
                    if (updates.length > 0) {
                        chatId = updates[updates.length - 1].message?.chat.id ?? null;
                        break;
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
                chatId,
                botUsername,
                configuredAt: new Date().toISOString(),
            });

            try {
                await api.sendMessage(chatId, "GenesisTools telegram-bot configured successfully!");
                p.log.success("Test message sent");
            } catch (err) {
                p.log.warn(`Could not send test message: ${(err as Error).message}`);
            }

            p.outro("Configuration complete!");
        });
}
