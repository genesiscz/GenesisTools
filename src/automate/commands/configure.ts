import { Command } from "commander";
import * as p from "@clack/prompts";
import { loadTelegramConfig } from "@app/telegram-bot/lib/config";

export function registerConfigureCommand(program: Command): Command {
  const cmd = program.command("configure").description("Setup wizard and credential management");
  cmd.action(async () => {
    p.intro("automate configure");

    const telegramConfig = await loadTelegramConfig();
    if (telegramConfig) {
      p.log.success(`Telegram: configured (@${telegramConfig.botUsername ?? "bot"}, chat ${telegramConfig.chatId})`);
    } else {
      p.log.warn("Telegram: not configured");
    }

    const section = await p.select({
      message: "What would you like to configure?",
      options: [
        {
          value: "telegram",
          label: "Telegram Bot",
          hint: telegramConfig ? "Reconfigure" : "Set up notifications via Telegram",
        },
        { value: "done", label: "Done", hint: "Exit configuration" },
      ],
    });
    if (p.isCancel(section) || section === "done") { p.outro("Configuration complete"); return; }
    if (section === "telegram") {
      const toolsPath = new URL("../../../tools", import.meta.url).pathname;
      const proc = Bun.spawn(["bun", "run", toolsPath, "telegram-bot", "configure"], {
        stdio: ["inherit", "inherit", "inherit"],
      });
      await proc.exited;
    }
    p.outro("Configuration complete");
  });
  return cmd;
}
