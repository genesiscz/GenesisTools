import { resolve } from "node:path";
import type { Bot } from "grammy";
import { stripAnsi, truncateForTelegram } from "../formatting";

const TOOLS_PATH = resolve(import.meta.dir, "../../../../tools");

export function registerToolsCommand(bot: Bot): void {
  bot.command("tools", async (ctx) => {
    const args = ctx.match?.trim();
    if (!args) { await ctx.reply("Usage: /tools <command> [args]\nExample: /tools claude usage"); return; }

    const parts = args.split(/\s+/);
    const proc = Bun.spawn(["bun", "run", TOOLS_PATH, ...parts], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 30_000,
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const output = stripAnsi(stdout + (stderr ? `\n${stderr}` : "")).trim();

    await ctx.reply(truncateForTelegram(output || "(no output)"));
  });
}
