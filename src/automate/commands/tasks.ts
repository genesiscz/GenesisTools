import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getDb } from "@app/automate/lib/db";
import { formatTable } from "@app/utils/table";
import { formatDuration } from "@app/utils/format";

export function registerTasksCommand(program: Command): void {
  const tasks = program.command("tasks").description("View execution history");

  tasks
    .command("list", { isDefault: true })
    .alias("ls")
    .description("Show recent runs")
    .option("-n, --limit <n>", "Number of runs to show", "20")
    .action((opts) => {
      const db = getDb();
      const runs = db.listRuns(parseInt(opts.limit));
      if (runs.length === 0) {
        p.log.info("No runs recorded yet.");
        return;
      }
      const headers = ["ID", "Preset", "Trigger", "Status", "Started", "Duration", "Steps"];
      const rows = runs.map(r => [
        String(r.id),
        r.preset_name,
        r.trigger_type,
        r.status === "success" ? pc.green(r.status) : r.status === "error" ? pc.red(r.status) : pc.yellow(r.status),
        r.started_at,
        r.duration_ms != null ? formatDuration(r.duration_ms) : pc.dim("running..."),
        String(r.step_count),
      ]);
      console.log(formatTable(rows, headers));
    });

  tasks
    .command("show <run-id>")
    .description("Show detailed run with per-step logs")
    .action((runIdStr: string) => {
      const db = getDb();
      const runId = parseInt(runIdStr);
      const run = db.getRun(runId);
      if (!run) { p.log.error(`Run #${runId} not found`); return; }

      p.log.info(`Run #${run.id} — ${run.preset_name}`);
      p.log.info(`Trigger: ${run.trigger_type} | Status: ${run.status} | Duration: ${run.duration_ms != null ? formatDuration(run.duration_ms) : "running"}`);
      if (run.error) p.log.error(`Error: ${run.error}`);

      const logs = db.getRunLogs(runId);
      if (logs.length === 0) { p.log.info("No step logs recorded."); return; }

      const headers = ["#", "Step", "Action", "Status", "Duration", "Error"];
      const logRows = logs.map(l => [
        String(l.step_index + 1),
        l.step_name,
        l.action,
        l.status === "success" ? pc.green(l.status) : l.status === "error" ? pc.red(l.status) : pc.dim(l.status),
        formatDuration(l.duration_ms),
        l.error ? pc.red(l.error.slice(0, 80)) : "",
      ]);
      console.log(formatTable(logRows, headers));
    });
}
