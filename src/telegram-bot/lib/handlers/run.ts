import { listPresets } from "@app/automate/lib/storage";
import { stripAnsi, truncateForTelegram } from "@app/telegram-bot/lib/formatting";
import { runTool } from "@app/utils/cli/tools";
import * as p from "@clack/prompts";
import type { Bot } from "grammy";

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
                ...presets.map((pr) => `  ${pr.name} — ${pr.description ?? "(no description)"}`),
            ];
            await ctx.reply(lines.join("\n"));
            p.log.success(`/run → listed ${presets.length} presets`);
            return;
        }

        const presetName = args.split(/\s+/)[0];
        p.log.step(`/run → executing preset "${presetName}"`);
        const result = await runTool(["automate", "run", presetName], { env: { NO_COLOR: "1" }, timeout: 120_000 });
        const exitCode = result.exitCode;
        const output = stripAnsi(result.stdout + (result.stderr ? `\n${result.stderr}` : "")).trim();

        const prefix =
            exitCode === 0 ? `Preset "${presetName}" completed.` : `Preset "${presetName}" failed (exit ${exitCode}).`;

        await ctx.reply(truncateForTelegram(`${prefix}\n\n${output || "(no output)"}`));
        p.log.success(`/run → ${presetName} exit=${exitCode}`);
    });
}
