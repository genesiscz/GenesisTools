// src/automate/commands/list.ts

import * as p from "@clack/prompts";
import pc from "picocolors";
import type { Command } from "commander";
import { ensureStorage, listPresets } from "@app/automate/lib/storage.ts";
import { formatRelativeTime } from "@app/utils/format.ts";

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .alias("ls")
    .description("List all available presets")
    .action(async () => {
      p.intro(pc.bgCyan(pc.black(" automate list ")));

      await ensureStorage();
      const presets = await listPresets();

      if (presets.length === 0) {
        p.log.warn("No presets found.");
        p.log.info(`Create one with: ${pc.cyan("tools automate preset create")}`);
        p.log.info(`Or save a JSON file to: ${pc.dim("~/.genesis-tools/automate/presets/")}`);
        p.outro("");
        return;
      }

      for (const preset of presets) {
        const lastRun = preset.meta.lastRun
          ? formatRelativeTime(new Date(preset.meta.lastRun))
          : pc.dim("never");

        p.log.info(
          `${pc.bold(preset.name)} ${pc.dim(`(${preset.fileName})`)}\n` +
          (preset.description ? `  ${preset.description}\n` : "") +
          `  ${pc.dim("Steps:")} ${preset.stepCount}  ${pc.dim("Last run:")} ${lastRun}` +
          (preset.meta.runCount ? `  ${pc.dim("Runs:")} ${preset.meta.runCount}` : ""),
        );
      }

      p.outro(`${presets.length} preset(s) found`);
    });
}
