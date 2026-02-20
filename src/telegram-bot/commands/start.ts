import { createBot } from "@app/telegram-bot/lib/bot";
import { loadTelegramConfig } from "@app/telegram-bot/lib/config";
import { COMMANDS } from "@app/telegram-bot/lib/handlers/help";
import * as p from "@clack/prompts";
import type { Command } from "commander";

export function registerStartCommand(program: Command): void {
    program
        .command("start")
        .description("Start interactive bot (long-polling)")
        .action(async () => {
            const config = await loadTelegramConfig();
            if (!config) {
                p.log.error("Telegram not configured. Run: tools telegram-bot configure");
                process.exit(1);
            }

            const bot = createBot(config.botToken, config.chatId);

            const me = await bot.api.getMe();
            p.log.success(`Starting bot @${me.username ?? me.first_name} (Ctrl+C to stop)`);

            await bot.api.setMyCommands(COMMANDS);

            let pollCount = 0;
            const timeout = 30;
            await bot.start({
                timeout,
                onStart: () => {
                    pollCount++;
                    p.log.info(`Polling started (long-polling, ${timeout}s timeout, run #${pollCount})`);
                },
            });
        });
}
