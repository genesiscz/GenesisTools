import type { Bot } from "grammy";
import * as p from "@clack/prompts";
import { runTool } from "@app/utils/cli/tools";
import { stripAnsi, truncateForTelegram } from "@app/telegram-bot/lib/formatting";

export function registerToolsCommand(bot: Bot): void {
  bot.command("tools", async (ctx) => {
    const args = ctx.match?.trim();
    if (!args) { p.log.warn("/tools → missing command"); await ctx.reply("Usage: /tools <command> [args]\nExample: /tools claude usage"); return; }

    const parts = args.split(/\s+/);
    p.log.step(`/tools → running: tools ${args}`);
    const result = await runTool(parts, { env: { NO_COLOR: "1" }, timeout: 30_000 });
    const output = stripAnsi(result.stdout + (result.stderr ? `\n${result.stderr}` : "")).trim();

    await ctx.reply(truncateForTelegram(output || "(no output)"));
    p.log.success(`/tools → replied (${output.length} chars)`);
  });
}
