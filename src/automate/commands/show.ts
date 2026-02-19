// src/automate/commands/show.ts

import * as p from "@clack/prompts";
import pc from "picocolors";
import type { Command } from "commander";
import { getPresetMeta, listPresets, loadPreset } from "@app/automate/lib/storage.ts";
import { isBuiltinAction } from "@app/automate/lib/builtins.ts";
import { formatRelativeTime } from "@app/utils/format.ts";

export function registerShowCommand(program: Command): void {
  program
    .command("show [preset]")
    .description("Show preset details (variables, steps, metadata)")
    .action(async (presetArg?: string) => {
      p.intro(pc.bgCyan(pc.black(" automate show ")));

      if (!presetArg) {
        const presets = await listPresets();
        if (presets.length === 0) { p.log.warn("No presets found."); p.outro(""); return; }
        p.log.step(pc.underline("Available presets:"));
        for (const pr of presets) {
          p.log.info(`  ${pc.cyan(pr.fileName.replace(".json", ""))} — ${pr.description ?? pc.dim("(no description)")}`);
        }
        p.outro("");
        return;
      }

      let preset;
      try {
        preset = await loadPreset(presetArg);
      } catch (error) {
        p.log.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }

      // Header
      p.log.info(pc.bold(preset.name));
      if (preset.description) {
        p.log.info(pc.dim(preset.description));
      }

      // Variables
      if (preset.vars && Object.keys(preset.vars).length > 0) {
        p.log.step(pc.underline("Variables:"));
        for (const [key, def] of Object.entries(preset.vars)) {
          const defaultStr = def.default != null
            ? pc.dim(` = ${def.default}`)
            : pc.yellow(" (required)");
          p.log.info(`  ${pc.cyan(key)} (${def.type})${defaultStr}`);
          if (def.description) {
            p.log.info(`    ${pc.dim(def.description)}`);
          }
        }
      }

      // Steps
      p.log.step(pc.underline("Steps:"));
      for (let i = 0; i < preset.steps.length; i++) {
        const step = preset.steps[i];
        const isBuiltin = isBuiltinAction(step.action);
        const actionLabel = isBuiltin
          ? pc.magenta(step.action)
          : pc.cyan(`tools ${step.action}`);

        const flags: string[] = [];
        if (step.interactive) flags.push(pc.yellow("interactive"));
        if (step.onError && step.onError !== "stop") flags.push(pc.dim(`onError:${step.onError}`));
        if (step.output) flags.push(pc.dim(`-> ${step.output}`));

        p.log.info(
          `  ${pc.dim(`${i + 1}.`)} ${pc.bold(step.name)} ${pc.dim(`(${step.id})`)}\n` +
          `     ${actionLabel}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}`,
        );
      }

      // Metadata
      const meta = await getPresetMeta(preset.name);
      if (meta.lastRun) {
        p.log.step(pc.underline("History:"));
        p.log.info(`  Last run: ${formatRelativeTime(new Date(meta.lastRun))}`);
        p.log.info(`  Total runs: ${meta.runCount ?? 0}`);
      }

      p.outro("");
    });
}
