import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getDb } from "@app/automate/lib/db";
import { listPresets } from "@app/automate/lib/storage";
import { parseInterval, computeNextRunAt } from "@app/automate/lib/interval-parser";
import { formatTable } from "@app/utils/table";

export function registerScheduleCommand(program: Command): void {
  const schedule = program.command("schedule").description("Manage scheduled preset executions");

  schedule
    .command("list")
    .alias("ls")
    .description("Show all schedules")
    .action(() => {
      const db = getDb();
      const schedules = db.listSchedules();
      if (schedules.length === 0) {
        p.log.info("No schedules configured. Run: tools automate schedule create");
        return;
      }
      const headers = ["Name", "Preset", "Interval", "Enabled", "Last Run", "Next Run"];
      const rows = schedules.map(s => [
        s.name,
        s.preset_name,
        s.interval,
        s.enabled ? pc.green("yes") : pc.dim("no"),
        s.last_run_at ?? pc.dim("never"),
        s.enabled ? s.next_run_at : pc.dim("—"),
      ]);
      console.log(formatTable(rows, headers));
    });

  schedule
    .command("create")
    .description("Create a new schedule interactively")
    .action(async () => {
      const presets = await listPresets();
      if (presets.length === 0) {
        p.log.error("No presets found. Create one first: tools automate create");
        return;
      }

      const presetName = await p.select({
        message: "Which preset to schedule?",
        options: presets.map(pr => ({
          value: pr.fileName.replace(".json", ""),
          label: `${pr.name} — ${pr.description ?? ""}`,
        })),
      });
      if (p.isCancel(presetName)) return;

      const name = await p.text({
        message: "Schedule name (unique identifier):",
        placeholder: `${presetName}-daily`,
        validate: (val) => {
          if (!val || !/^[a-zA-Z0-9_-]+$/.test(val)) return "Only alphanumeric, hyphens, underscores";
          const db = getDb();
          if (db.getSchedule(val)) return "Schedule name already exists";
        },
      });
      if (p.isCancel(name)) return;

      const interval = await p.text({
        message: "Run interval:",
        placeholder: "every 5 minutes",
        validate: (val) => {
          if (!val) return "Interval is required";
          try { parseInterval(val); } catch (e) { return (e as Error).message; }
        },
      });
      if (p.isCancel(interval)) return;

      const parsed = parseInterval(interval as string);
      const nextRunAt = computeNextRunAt(parsed).toISOString();

      const db = getDb();
      db.createSchedule(name as string, presetName as string, interval as string, nextRunAt);
      p.log.success(`Schedule "${name}" created. Next run: ${nextRunAt}`);
      p.log.info("Start the daemon to begin executing: tools automate daemon start");
    });

  schedule
    .command("enable <name>")
    .description("Enable a schedule")
    .action((name: string) => {
      const db = getDb();
      const existing = db.getSchedule(name);
      if (!existing) { p.log.error(`Schedule "${name}" not found`); return; }
      const parsed = parseInterval(existing.interval);
      const nextRunAt = computeNextRunAt(parsed).toISOString();
      db.setScheduleEnabled(name, true);
      db.updateScheduleAfterRun(existing.id, nextRunAt);
      p.log.success(`Schedule "${name}" enabled. Next run: ${nextRunAt}`);
    });

  schedule
    .command("disable <name>")
    .description("Disable a schedule")
    .action((name: string) => {
      const db = getDb();
      if (!db.getSchedule(name)) { p.log.error(`Schedule "${name}" not found`); return; }
      db.setScheduleEnabled(name, false);
      p.log.success(`Schedule "${name}" disabled`);
    });

  schedule
    .command("delete <name>")
    .description("Delete a schedule")
    .action(async (name: string) => {
      const db = getDb();
      if (!db.getSchedule(name)) { p.log.error(`Schedule "${name}" not found`); return; }
      const confirm = await p.confirm({ message: `Delete schedule "${name}"?` });
      if (p.isCancel(confirm) || !confirm) return;
      db.deleteSchedule(name);
      p.log.success(`Schedule "${name}" deleted`);
    });
}
