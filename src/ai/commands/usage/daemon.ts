import { resolve } from "node:path";
import { parseInterval } from "@app/daemon/lib/interval";
import { getDaemonStatus } from "@app/daemon/lib/launchd";
import { isTaskRegistered, registerTask, unregisterTask } from "@app/daemon/lib/register";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

/** One task for every provider (spec 2026-09-04 section 6.5). */
export const USAGE_TASK_NAME = "ai-usage-poll";

/** The claude-only task this replaces. `register` removes it, which is decision D11. */
export const LEGACY_USAGE_TASK_NAME = "claude-usage-poll";

const POLL_SCRIPT = resolve(import.meta.dir, "./poll-daemon.ts");

function bunPath(): string {
    return Bun.which("bun") ?? "bun";
}

export function validateRetentionMin(raw: string): number | null {
    const minRuns = Number(raw);

    if (!Number.isInteger(minRuns) || minRuns < 1) {
        return null;
    }

    return minRuns;
}

export function validateRetentionDays(raw: string): number | null {
    const maxAgeDays = Number(raw);

    if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
        return null;
    }

    return maxAgeDays;
}

/** Injected so the registration logic is unit-testable without touching launchd. */
export interface DaemonRegistry {
    registerTask: typeof registerTask;
    unregisterTask: typeof unregisterTask;
    isTaskRegistered: typeof isTaskRegistered;
}

const REAL_REGISTRY: DaemonRegistry = { registerTask, unregisterTask, isTaskRegistered };

export interface RegisterUsagePollArgs {
    interval: string;
    maxAgeDays: number;
    minRuns: number;
    /** Absolute path of the poll script. Defaults to the one beside this file. */
    script?: string;
    registry?: DaemonRegistry;
}

export interface RegisterUsagePollResult {
    created: boolean;
    /** True when the claude-only task existed and was removed in the same call. */
    migratedFromLegacy: boolean;
}

/**
 * Register `ai-usage-poll`, removing `claude-usage-poll` first when it is still there.
 * Running both would poll every anthropic account twice a minute, so the removal is not
 * optional cleanup: it is the migration (D11, spec section 13.7).
 */
export async function registerUsagePollTask(args: RegisterUsagePollArgs): Promise<RegisterUsagePollResult> {
    const registry = args.registry ?? REAL_REGISTRY;
    // Before the migration, not inside it: `registerTask` parses the interval as its very
    // first act, so a typo used to delete `claude-usage-poll` and then throw, leaving the
    // machine with no usage task at all.
    parseInterval(args.interval);

    let migratedFromLegacy = false;

    if (await registry.isTaskRegistered(LEGACY_USAGE_TASK_NAME)) {
        migratedFromLegacy = await registry.unregisterTask(LEGACY_USAGE_TASK_NAME);
    }

    // `registerTask` answers `true` for a create AND for an overwrite, so the create/update
    // wording has to come from asking first.
    const created = !(await registry.isTaskRegistered(USAGE_TASK_NAME));

    await registry.registerTask({
        name: USAGE_TASK_NAME,
        command: `${bunPath()} run ${args.script ?? POLL_SCRIPT}`,
        every: args.interval,
        retries: 1,
        timeoutMs: 60_000,
        description: "Poll every AI provider's usage limits and record them to the limits store",
        overwrite: true,
        notify: false,
        retention: {
            maxAgeDays: args.maxAgeDays,
            minRuns: args.minRuns,
        },
    });

    return { created, migratedFromLegacy };
}

/**
 * `daemon register|unregister|status` for one program. `tools ai usage daemon` and
 * `tools claude daemon` mount the same three commands, so the claude alias cannot drift.
 */
export function registerUsageDaemonCommands(program: Command): void {
    const daemon = program.command("daemon").description("Manage background usage polling via the daemon scheduler");

    daemon
        .command("register")
        .description("Register usage polling as a daemon task")
        // 30s, not 60s: the usage buckets are what every picker and dashboard
        // ranks accounts by, and a minute-old reading is already wrong after a
        // busy turn. Only HEALTHY accounts pay for it — lapsed and failing ones
        // are held back by the poll gate (src/utils/ai/usage-poll/poll-gate.ts).
        .option("-i, --interval <interval>", "Polling interval", "every 30 seconds")
        .option("--retention-days <days>", "Delete run logs older than N days (with --retention-min)", "3")
        .option("--retention-min <count>", "Always keep at least N newest run logs", "100")
        .action(async (opts: { interval: string; retentionDays: string; retentionMin: string }) => {
            const maxAgeDays = validateRetentionDays(opts.retentionDays);
            const minRuns = validateRetentionMin(opts.retentionMin);

            if (maxAgeDays === null) {
                p.log.error(`Invalid --retention-days: "${opts.retentionDays}" (expected a non-negative number)`);
                process.exit(1);
            }

            if (minRuns === null) {
                p.log.error(`Invalid --retention-min: "${opts.retentionMin}" (expected an integer of at least 1)`);
                process.exit(1);
            }

            const { created, migratedFromLegacy } = await registerUsagePollTask({
                interval: opts.interval,
                maxAgeDays,
                minRuns,
            });

            if (migratedFromLegacy) {
                p.log.info(`Removed the old task ${pc.cyan(LEGACY_USAGE_TASK_NAME)}`);
            }

            if (created) {
                p.log.success(`Registered task ${pc.cyan(USAGE_TASK_NAME)} (${opts.interval})`);
            } else {
                p.log.info(`Updated task ${pc.cyan(USAGE_TASK_NAME)} (${opts.interval})`);
            }

            const status = await getDaemonStatus();

            if (!status.running) {
                p.log.warn(
                    `Daemon is not running. Start it with: ${pc.cyan("tools daemon start")} or ${pc.cyan("tools daemon install")}`
                );
            }
        });

    daemon
        .command("unregister")
        .description("Remove usage polling from daemon")
        .action(async () => {
            const removed = await unregisterTask(USAGE_TASK_NAME);

            if (removed) {
                p.log.success(`Removed task ${pc.cyan(USAGE_TASK_NAME)}`);
            } else {
                p.log.warn(`Task ${pc.cyan(USAGE_TASK_NAME)} was not registered`);
            }
        });

    daemon
        .command("status")
        .description("Check if usage polling is registered and daemon status")
        .action(async () => {
            const registered = await isTaskRegistered(USAGE_TASK_NAME);
            const daemonStatus = await getDaemonStatus();

            if (registered) {
                p.log.success(`Task ${pc.cyan(USAGE_TASK_NAME)} is registered`);
            } else {
                p.log.warn(
                    `Task ${pc.cyan(USAGE_TASK_NAME)} is not registered. Run: ${pc.cyan("tools ai usage daemon register")}`
                );
            }

            if (await isTaskRegistered(LEGACY_USAGE_TASK_NAME)) {
                p.log.warn(
                    `The old task ${pc.cyan(LEGACY_USAGE_TASK_NAME)} is still registered. Run: ${pc.cyan("tools ai usage daemon register")}`
                );
            }

            if (daemonStatus.running) {
                p.log.success(`Daemon running (PID ${daemonStatus.pid})`);
            } else if (daemonStatus.installed) {
                p.log.warn("Daemon installed but not running");
            } else {
                p.log.info(`Daemon not installed. Run: ${pc.cyan("tools daemon install")}`);
            }
        });
}
