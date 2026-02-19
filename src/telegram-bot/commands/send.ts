import type { Command } from "commander";
import * as p from "@clack/prompts";
import { Api } from "grammy";
import { loadTelegramConfig } from "@app/telegram-bot/lib/config";
import type { ParseMode } from "@app/telegram-bot/lib/types";

export function registerSendCommand(program: Command): void {
  program
    .command("send <message>")
    .description("Send a message via Telegram")
    .option("--parse-mode <mode>", "Parse mode: MarkdownV2 or HTML")
    .option("--stdin", "Read message from stdin")
    .action(async (message: string, opts: { parseMode?: string; stdin?: boolean }) => {
      const config = await loadTelegramConfig();
      if (!config) { p.log.error("Telegram not configured. Run: tools telegram-bot configure"); process.exit(1); }

      let text = message;
      if (opts.stdin) text = await new Response(Bun.stdin.stream()).text();

      const api = new Api(config.botToken);
      try {
        await api.sendMessage(config.chatId, text, {
          parse_mode: opts.parseMode as ParseMode | undefined,
        });
        p.log.success("Message sent");
      } catch (err) {
        p.log.error(`Failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
