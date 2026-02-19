import { loadPreset } from "./storage";
import { runPreset } from "./engine";
import { createRunLogger } from "./run-logger";
import { parseInterval, computeNextRunAt } from "./interval-parser";
import type { AutomateDatabase, ScheduleRow } from "./db";
import logger from "@app/logger";

export async function runSchedulerLoop(db: AutomateDatabase): Promise<void> {
  let running = true;
  const activeRuns = new Set<number>();

  const shutdown = () => { running = false; };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  logger.info("Scheduler loop started");

  while (running) {
    const now = new Date().toISOString();
    const dueSchedules = db.getDueSchedules(now);

    for (const schedule of dueSchedules) {
      if (activeRuns.has(schedule.id)) {
        logger.warn({ scheduleId: schedule.id, name: schedule.name }, "Skipping: still running");
        continue;
      }

      activeRuns.add(schedule.id);
      executeDueSchedule(db, schedule)
        .catch(err => logger.error({ err, scheduleId: schedule.id }, "Schedule execution failed"))
        .finally(() => {
          activeRuns.delete(schedule.id);
          try {
            const parsed = parseInterval(schedule.interval);
            const nextRunAt = computeNextRunAt(parsed).toISOString();
            db.updateScheduleAfterRun(schedule.id, nextRunAt);
          } catch (err) {
            logger.error({ err, scheduleId: schedule.id }, "Failed to update next_run_at");
          }
        });
    }

    const nextWakeup = getNextWakeupMs(db);
    const sleepMs = Math.min(Math.max(nextWakeup, 1000), 60_000);
    logger.debug({ sleepMs }, "Sleeping until next schedule");
    await Bun.sleep(sleepMs);
  }

  if (activeRuns.size > 0) {
    logger.info({ activeCount: activeRuns.size }, "Waiting for active runs...");
    const deadline = Date.now() + 30_000;
    while (activeRuns.size > 0 && Date.now() < deadline) {
      await Bun.sleep(500);
    }
  }

  logger.info("Scheduler loop stopped");
}

async function executeDueSchedule(db: AutomateDatabase, schedule: ScheduleRow): Promise<void> {
  logger.info({ name: schedule.name, preset: schedule.preset_name }, "Executing scheduled preset");
  const preset = await loadPreset(schedule.preset_name);
  const runLogger = createRunLogger(preset.name, schedule.id, "schedule", db);
  const vars = schedule.vars_json ? JSON.parse(schedule.vars_json) as Record<string, string> : undefined;
  const options = {
    vars: vars ? Object.entries(vars).map(([k, v]) => `${k}=${v}`) : undefined,
    verbose: false,
  };
  const result = await runPreset(preset, options, runLogger);
  logger.info({ name: schedule.name, success: result.success, duration: result.totalDuration }, "Schedule execution complete");
}

function getNextWakeupMs(db: AutomateDatabase): number {
  const schedules = db.listSchedules().filter(s => s.enabled);
  if (schedules.length === 0) return 60_000;
  const now = Date.now();
  let earliest = Infinity;
  for (const s of schedules) {
    const nextMs = new Date(s.next_run_at).getTime() - now;
    if (nextMs < earliest) earliest = nextMs;
  }
  return earliest;
}
