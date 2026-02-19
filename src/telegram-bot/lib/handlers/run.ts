import { resolve } from "node:path";
import type { Bot } from "grammy";
import * as p from "@clack/prompts";
import { listPresets } from "@app/automate/lib/storage";
import { stripAnsi } from "../formatting";
import { truncateForTelegram } from "../formatting";

const TOOLS_PATH = resolve(import.meta.dir, "../../../../tools");

export function registerRunCommand(bot: Bot): void {
  bot.command("run", async (ctx) => {
    const args = ctx.match?.trim();
    if (!args) {
      p.log.step("/run → listing available presets");
      const presets = await listPresets();
      const lines = [
        "Usage: /run <preset-name>",
        "",
        "Available presets:",
        ...presets.map(pr => `  ${pr.name} — ${pr.description ?? "(no description)"}`),
      ];
      await ctx.reply(lines.join("\n"));
      p.log.success(`/run → listed ${presets.length} presets`);
      return;
    }

    const presetName = args.split(/\s+/)[0];
    p.log.step(`/run → executing preset "${presetName}"`);
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
    p.log.success(`/run → ${presetName} exit=${exitCode}`);
  });
}
