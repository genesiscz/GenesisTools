import { Command } from "commander";
import * as p from "@clack/prompts";
import { createTelegramApi } from "@app/telegram-bot/lib/api";
import { saveTelegramConfig } from "@app/telegram-bot/lib/config";

export function registerConfigureCommand(program: Command): void {
  program.command("configure").description("Set up Telegram Bot for notifications").action(async () => {
    p.intro("telegram-bot configure");

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
        if (!val || !/^\d+:[A-Za-z0-9_-]+$/.test(val)) return "Invalid token format (expected: 123456:ABC...)";
      },
    });
    if (p.isCancel(token)) return;

    const api = createTelegramApi(token as string);
    let botUsername: string;
    try {
      const me = await api.getMe();
      botUsername = me.username ?? me.first_name;
      p.log.success(`Connected to bot: @${botUsername}`);
    } catch (err) {
      p.log.error(`Invalid token: ${(err as Error).message}`);
      return;
    }

    p.log.step("Now send any message to your bot in Telegram...");
    const spinner = p.spinner();
    spinner.start("Waiting for your message...");

    let chatId: number | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const updates = await api.getUpdates(undefined, 30);
        if (updates.length > 0) {
          chatId = updates[updates.length - 1].message?.chat.id ?? null;
          break;
        }
      } catch { /* retry */ }
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
      await api.sendMessage({ chat_id: chatId, text: "GenesisTools telegram-bot configured successfully!" });
      p.log.success("Test message sent");
    } catch (err) {
      p.log.warn(`Could not send test message: ${(err as Error).message}`);
    }

    p.outro("Configuration complete!");
  });
}
