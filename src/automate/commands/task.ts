import { getDb } from "@app/automate/lib/db";
import { runPreset } from "@app/automate/lib/engine";
import { computeNextRunAt, parseInterval } from "@app/automate/lib/interval-parser";
import { createRunLogger } from "@app/automate/lib/run-logger";
import { listPresets, loadPreset } from "@app/automate/lib/storage";
import { formatDuration } from "@app/utils/format";
import { formatTable } from "@app/utils/table";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

export function registerTaskCommand(parent: Command): void {
    // task list (default) — show all scheduled tasks
    parent
        .command("list", { isDefault: true })
        .alias("ls")
        .description("Show all scheduled tasks")
        .action(() => {
            const db = getDb();
            const schedules = db.listSchedules();
            if (schedules.length === 0) {
                p.log.info("No scheduled tasks. Run: tools automate task create");
                return;
            }
            const headers = ["Name", "Preset", "Interval", "Enabled", "Last Run", "Next Run"];
            const rows = schedules.map((s) => [
                s.name,
                s.preset_name,
                s.interval,
                s.enabled ? pc.green("yes") : pc.dim("no"),
                s.last_run_at ?? pc.dim("never"),
                s.enabled ? s.next_run_at : pc.dim("—"),
            ]);
            console.log(formatTable(rows, headers));
        });

    // task create — interactive schedule creation
    parent
        .command("create")
        .description("Create a new scheduled task interactively")
        .action(async () => {
            p.intro(pc.bgCyan(pc.black(" automate task create ")));

            const presets = await listPresets();
            if (presets.length === 0) {
                p.log.error("No presets found. Create one first: tools automate preset create");
                p.outro("");
                return;
            }

            const presetName = await p.select({
                message: "Which preset to schedule?",
                options: presets.map((pr) => ({
                    value: pr.fileName.replace(".json", ""),
                    label: `${pr.name} — ${pr.description ?? ""}`,
                })),
            });
            if (p.isCancel(presetName)) {
                return;
            }

            const name = await p.text({
                message: "Task name (unique identifier):",
                placeholder: `${presetName}-daily`,
                validate: (val) => {
                    if (!val || !/^[a-zA-Z0-9_-]+$/.test(val)) {
                        return "Only alphanumeric, hyphens, underscores";
                    }
                    const db = getDb();
                    if (db.getSchedule(val)) {
                        return "Task name already exists";
                    }
                },
            });
            if (p.isCancel(name)) {
                return;
            }

            const interval = await p.text({
                message: "Run interval:",
                placeholder: "every 5 minutes",
                validate: (val) => {
                    if (!val) {
                        return "Interval is required";
                    }
                    try {
                        parseInterval(val);
                    } catch (e) {
                        return (e as Error).message;
                    }
                },
            });
            if (p.isCancel(interval)) {
                return;
            }

            const parsed = parseInterval(interval as string);
            const nextRunAt = computeNextRunAt(parsed).toISOString();

            const db = getDb();
            db.createSchedule(name as string, presetName as string, interval as string, nextRunAt);
            p.log.success(`Task "${name}" created. Next run: ${nextRunAt}`);
            p.log.info("Start the daemon to begin executing: tools automate daemon start");
            p.outro("");
        });

    // task show <name-or-id> — show schedule details (by name) or run details (by numeric ID)
    parent
        .command("show <name-or-id>")
        .description("Show task details (by name) or run details (by numeric ID)")
        .action((arg: string) => {
            const db = getDb();
            const asNum = parseInt(arg, 10);

            // If it's a number, show run details
            if (!Number.isNaN(asNum) && String(asNum) === arg) {
                const run = db.getRun(asNum);
                if (!run) {
                    p.log.error(`Run #${asNum} not found`);
                    return;
                }

                p.log.info(`Run #${run.id} — ${run.preset_name}`);
                p.log.info(
                    `Trigger: ${run.trigger_type} | Status: ${run.status} | Duration: ${run.duration_ms != null ? formatDuration(run.duration_ms) : "running"}`
                );
                if (run.error) {
                    p.log.error(`Error: ${run.error}`);
                }

                const logs = db.getRunLogs(asNum);
                if (logs.length === 0) {
                    p.log.info("No step logs recorded.");
                    return;
                }

                const headers = ["#", "Step", "Action", "Status", "Duration", "Error"];
                const logRows = logs.map((l) => [
                    String(l.step_index + 1),
                    l.step_name,
                    l.action,
                    l.status === "success"
                        ? pc.green(l.status)
                        : l.status === "error"
                          ? pc.red(l.status)
                          : pc.dim(l.status),
                    formatDuration(l.duration_ms),
                    l.error ? pc.red(l.error.slice(0, 80)) : "",
                ]);
                console.log(formatTable(logRows, headers));
                return;
            }

            // Otherwise, show schedule details
            const schedule = db.getSchedule(arg);
            if (!schedule) {
                p.log.error(`Task "${arg}" not found`);
                return;
            }

            p.log.info(`${pc.bold(schedule.name)}`);
            p.log.info(`Preset: ${pc.cyan(schedule.preset_name)}`);
            p.log.info(`Interval: ${schedule.interval}`);
            p.log.info(`Enabled: ${schedule.enabled ? pc.green("yes") : pc.dim("no")}`);
            p.log.info(`Last run: ${schedule.last_run_at ?? pc.dim("never")}`);
            p.log.info(`Next run: ${schedule.enabled ? schedule.next_run_at : pc.dim("—")}`);

            // Show recent runs for this schedule
            const runs = db.listRuns(10);
            const scheduleRuns = runs.filter(
                (r) => r.preset_name === schedule.preset_name && r.trigger_type === "schedule"
            );
            if (scheduleRuns.length > 0) {
                p.log.step(pc.underline("Recent runs:"));
                const headers = ["ID", "Status", "Started", "Duration"];
                const rows = scheduleRuns.map((r) => [
                    String(r.id),
                    r.status === "success"
                        ? pc.green(r.status)
                        : r.status === "error"
                          ? pc.red(r.status)
                          : pc.yellow(r.status),
                    r.started_at,
                    r.duration_ms != null ? formatDuration(r.duration_ms) : pc.dim("running..."),
                ]);
                console.log(formatTable(rows, headers));
            }
        });

    // task enable <name>
    parent
        .command("enable <name>")
        .description("Enable a scheduled task")
        .action((name: string) => {
            const db = getDb();
            const existing = db.getSchedule(name);
            if (!existing) {
                p.log.error(`Task "${name}" not found`);
                return;
            }
            const parsed = parseInterval(existing.interval);
            const nextRunAt = computeNextRunAt(parsed).toISOString();
            db.setScheduleEnabled(name, true);
            db.updateScheduleAfterRun(existing.id, nextRunAt);
            p.log.success(`Task "${name}" enabled. Next run: ${nextRunAt}`);
        });

    // task disable <name>
    parent
        .command("disable <name>")
        .description("Disable a scheduled task")
        .action((name: string) => {
            const db = getDb();
            if (!db.getSchedule(name)) {
                p.log.error(`Task "${name}" not found`);
                return;
            }
            db.setScheduleEnabled(name, false);
            p.log.success(`Task "${name}" disabled`);
        });

    // task delete <name>
    parent
        .command("delete <name>")
        .description("Delete a scheduled task")
        .action(async (name: string) => {
            const db = getDb();
            if (!db.getSchedule(name)) {
                p.log.error(`Task "${name}" not found`);
                return;
            }
            const confirm = await p.confirm({ message: `Delete task "${name}"?` });
            if (p.isCancel(confirm) || !confirm) {
                return;
            }
            db.deleteSchedule(name);
            p.log.success(`Task "${name}" deleted`);
        });

    // task run <name> — manually trigger a scheduled task's preset
    parent
        .command("run <name>")
        .description("Manually run a scheduled task's preset now")
        .option("-v, --verbose", "Verbose output")
        .action(async (name: string, opts: { verbose?: boolean }) => {
            const db = getDb();
            const schedule = db.getSchedule(name);
            if (!schedule) {
                p.log.error(`Task "${name}" not found`);
                return;
            }

            p.intro(pc.bgCyan(pc.black(` task run: ${schedule.preset_name} `)));

            const preset = await loadPreset(schedule.preset_name);
            const vars = schedule.vars_json ? (JSON.parse(schedule.vars_json) as Record<string, string>) : undefined;
            const runLogger = createRunLogger(preset.name, schedule.id, "manual");

            const result = await runPreset(
                preset,
                {
                    vars: vars ? Object.entries(vars).map(([k, v]) => `${k}=${v}`) : undefined,
                    verbose: opts.verbose,
                },
                runLogger
            );

            const successCount = result.steps.filter((s) => s.result.status === "success").length;
            const failCount = result.steps.filter((s) => s.result.status === "error").length;
            const parts: string[] = [];
            if (successCount > 0) {
                parts.push(pc.green(`${successCount} passed`));
            }
            if (failCount > 0) {
                parts.push(pc.red(`${failCount} failed`));
            }

            p.outro(
                result.success
                    ? pc.green(`Done in ${formatDuration(result.totalDuration)} (${parts.join(", ")})`)
                    : pc.red(`Failed after ${formatDuration(result.totalDuration)} (${parts.join(", ")})`)
            );

            if (!result.success) {
                process.exit(1);
            }
        });

    // task history — show recent execution runs
    parent
        .command("history")
        .description("Show recent execution runs")
        .option("-n, --limit <n>", "Number of runs to show", "20")
        .action((opts) => {
            const db = getDb();
            const runs = db.listRuns(parseInt(opts.limit, 10));
            if (runs.length === 0) {
                p.log.info("No runs recorded yet.");
                return;
            }
            const headers = ["ID", "Preset", "Trigger", "Status", "Started", "Duration", "Steps"];
            const rows = runs.map((r) => [
                String(r.id),
                r.preset_name,
                r.trigger_type,
                r.status === "success"
                    ? pc.green(r.status)
                    : r.status === "error"
                      ? pc.red(r.status)
                      : pc.yellow(r.status),
                r.started_at,
                r.duration_ms != null ? formatDuration(r.duration_ms) : pc.dim("running..."),
                String(r.step_count),
            ]);
            console.log(formatTable(rows, headers));
        });
}
