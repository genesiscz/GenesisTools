// src/automate/commands/run.ts

import * as p from "@clack/prompts";
import pc from "picocolors";
import type { Command } from "commander";
import { loadPreset } from "@app/automate/lib/storage.ts";
import { runPreset } from "@app/automate/lib/engine.ts";
import { formatDuration } from "@app/utils/format.ts";

export function registerRunCommand(program: Command): void {
  program
    .command("run <preset>")
    .description("Run a preset by name or file path")
    .option("--dry-run", "Show what would execute without running")
    .option("--var <keyval...>", "Override variables (key=value)")
    .option("-v, --verbose", "Verbose output")
    .action(async (presetArg: string, opts: { dryRun?: boolean; var?: string[]; verbose?: boolean }) => {
      p.intro(pc.bgCyan(pc.black(" automate run ")));

      // Load preset
      const loadSpinner = p.spinner();
      loadSpinner.start("Loading preset...");

      let preset;
      try {
        preset = await loadPreset(presetArg);
        loadSpinner.stop(`Loaded: ${pc.bold(preset.name)}`);
      } catch (error) {
        loadSpinner.stop(pc.red("Failed to load preset"));
        p.log.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }

      if (preset.description) {
        p.log.info(pc.dim(preset.description));
      }

      // Execute the preset
      const result = await runPreset(preset, {
        dryRun: opts.dryRun,
        vars: opts.var,
        verbose: opts.verbose,
      });

      // Summary
      const successCount = result.steps.filter((s) => s.result.status === "success").length;
      const failCount = result.steps.filter((s) => s.result.status === "error").length;
      const skipCount = result.steps.filter((s) => s.result.status === "skipped").length;

      const summaryParts: string[] = [];
      if (successCount > 0) summaryParts.push(pc.green(`${successCount} passed`));
      if (failCount > 0) summaryParts.push(pc.red(`${failCount} failed`));
      if (skipCount > 0) summaryParts.push(pc.dim(`${skipCount} skipped`));

      p.outro(
        result.success
          ? pc.green(`Done in ${formatDuration(result.totalDuration)} (${summaryParts.join(", ")})`)
          : pc.red(`Failed after ${formatDuration(result.totalDuration)} (${summaryParts.join(", ")})`),
      );

      if (!result.success) process.exit(1);
    });
}
