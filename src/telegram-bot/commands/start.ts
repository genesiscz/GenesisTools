import { Command } from "commander";
import * as p from "@clack/prompts";
import { createTelegramApi } from "@app/telegram-bot/lib/api";
import { loadTelegramConfig } from "@app/telegram-bot/lib/config";
import { startPolling } from "@app/telegram-bot/lib/poller";

import "@app/telegram-bot/lib/handlers";

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

      const api = createTelegramApi(config.botToken);
      const me = await api.getMe();
      p.log.success(`Starting bot @${me.username ?? me.first_name} (Ctrl+C to stop)`);

      await startPolling(api, config.chatId);
    });
}
