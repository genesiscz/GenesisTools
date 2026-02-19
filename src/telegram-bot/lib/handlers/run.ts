import { resolve } from "node:path";
import type { Bot } from "grammy";
import { stripAnsi } from "../formatting";
import { truncateForTelegram } from "../formatting";

const TOOLS_PATH = resolve(import.meta.dir, "../../../../tools");

export function registerRunCommand(bot: Bot): void {
  bot.command("run", async (ctx) => {
    const args = ctx.match?.trim();
    if (!args) { await ctx.reply("Usage: /run <preset-name>"); return; }

    const presetName = args.split(/\s+/)[0];
    const proc = Bun.spawn(["bun", "run", TOOLS_PATH, "automate", "run", presetName], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 120_000,
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    const output = stripAnsi(stdout + (stderr ? `\n${stderr}` : "")).trim();

    const prefix = exitCode === 0
      ? `Preset "${presetName}" completed.`
      : `Preset "${presetName}" failed (exit ${exitCode}).`;

    await ctx.reply(truncateForTelegram(`${prefix}\n\n${output || "(no output)"}`));
  });
}
