#!/usr/bin/env bun

import { isTaskRegistered, registerTask, unregisterTask } from "@app/daemon/lib/register";
import { isInteractive, runTool, suggestCommand } from "@genesiscz/utils/cli";
import { formatDuration, formatList } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import { sendNotification } from "@genesiscz/utils/macos/notifications";
import * as p from "@genesiscz/utils/prompts/p";
import { idleDecisions, readClientPorts, readIdleState, writeIdleState } from "@genesiscz/utils/services/idle";
import { listServices, type ServiceRow } from "@genesiscz/utils/services/inventory";
import { restartService, stopService } from "@genesiscz/utils/services/lifecycle";
import { type StaleRow, withStaleness } from "@genesiscz/utils/services/stale";
import { createBoxTable, formatDotStatus, renderCliHeader } from "@genesiscz/utils/table";
import { Command } from "commander";
import pc from "picocolors";

const IDLE_TASK = "services-idle-reap";
const DEFAULT_IDLE_HOURS = 24;

const program = new Command();

program
    .name("services")
    .description(
        "Long-running GenesisTools servers: which run old code, restart them, stop on-demand ones when idle. Agent sessions are never touched."
    );

function codeCell(row: StaleRow<ServiceRow>): string {
    return row.stale.length === 0
        ? formatDotStatus("ok", "current")
        : formatDotStatus("warn", `old: ${row.stale.length} file(s) changed`);
}

function printTable(rows: StaleRow<ServiceRow>[]): void {
    renderCliHeader("GenesisTools services", `${rows.length} running`);
    const table = createBoxTable(["SERVICE", "PORT", "PID", "UP", "MANAGED", "CODE"]);

    for (const row of rows) {
        table.push([
            pc.white(row.id),
            row.port === null ? pc.dim("—") : String(row.port),
            String(row.rootPid),
            row.startedAt === null ? pc.dim("—") : formatDuration(Date.now() - row.startedAt),
            row.managed === "launchd" ? pc.blue(`launchd ${row.label}`) : "detached",
            codeCell(row),
        ]);
    }

    out.println(table.toString());
}

program
    .command("list", { isDefault: true })
    .description("List the running services and whether each runs the current code")
    .option("--json", "Print the rows, with the changed files, as JSON")
    .action((options: { json?: boolean }) => {
        const rows = withStaleness(listServices());

        if (options.json) {
            out.result(rows);
            return;
        }

        printTable(rows);
        const old = rows.filter((row) => row.stale.length > 0).length;

        if (old > 0) {
            out.println(
                `Restart the ${old} on old code: ${suggestCommand("tools services", { replaceCommand: ["restart", "--stale"] })}`
            );
        }
    });

program
    .command("restart")
    .description("Restart services on the current code (launchd jobs through launchd)")
    .argument("[ids...]", "Service ids from `tools services`")
    .option("--stale", "Every service on old code")
    .option("--all", "Every service")
    .action(async (ids: string[], options: { stale?: boolean; all?: boolean }) => {
        const rows = withStaleness(listServices());
        const chosen = await chooseRows(rows, ids, options);

        if (chosen === null) {
            process.exitCode = 1;
            return;
        }

        if (chosen.length === 0) {
            out.println("Nothing to restart.");
            return;
        }

        for (const row of chosen) {
            const result = await restartService(row);
            logger.debug({ id: row.id, ok: result.ok, message: result.message }, "services: restart");
            out.println(result.ok ? `${pc.green("✓")} ${result.message}` : `${pc.red("✗")} ${result.message}`);

            if (!result.ok) {
                process.exitCode = 1;
            }
        }
    });

/** The rows to act on; null when the choice is invalid or cancelled (the reason is printed). */
async function chooseRows(
    rows: StaleRow<ServiceRow>[],
    ids: string[],
    options: { stale?: boolean; all?: boolean }
): Promise<StaleRow<ServiceRow>[] | null> {
    if (options.all) {
        return rows;
    }

    if (options.stale) {
        return rows.filter((row) => row.stale.length > 0);
    }

    if (ids.length > 0) {
        const unknown = ids.filter((id) => !rows.some((row) => row.id === id));

        if (unknown.length > 0) {
            out.error(
                `Not running: ${unknown.join(", ")}. Running: ${rows.map((row) => row.id).join(", ") || "(none)"}`
            );
            return null;
        }

        return rows.filter((row) => ids.includes(row.id));
    }

    if (!isInteractive()) {
        out.error("Name the services, or pass --stale or --all.");
        out.info(suggestCommand("tools services", { replaceCommand: ["restart", "--stale"] }));
        return null;
    }

    const picked = await p.multiselect({
        message: "Restart which services?",
        options: rows.map((row) => ({
            value: row.id,
            label: row.id,
            hint: row.stale.length > 0 ? `old code, ${row.stale.length} file(s) changed` : "current",
        })),
        initialValues: rows.filter((row) => row.stale.length > 0).map((row) => row.id),
        required: false,
    });

    if (p.isCancel(picked)) {
        return null;
    }

    return rows.filter((row) => picked.includes(row.id));
}

program
    .command("reap-idle")
    .description(
        "Stop on-demand servers no client used for --idle-hours (never a launchd job). The daemon runs this; see `idle install`."
    )
    .option("--idle-hours <hours>", "Hours without a connected client", String(DEFAULT_IDLE_HOURS))
    .option("--dry-run", "Only print what would stop")
    .action(async (options: { idleHours: string; dryRun?: boolean }) => {
        const hours = Number(options.idleHours);

        if (!Number.isFinite(hours) || hours <= 0) {
            out.error(`--idle-hours must be a positive number, got ${options.idleHours}`);
            logger.warn({ idleHours: options.idleHours }, "services: reap-idle refused an invalid --idle-hours");
            process.exitCode = 1;
            return;
        }

        logger.debug({ idleHours: hours, dryRun: options.dryRun === true }, "services: reap-idle start");
        const rows = listServices();
        const clients = readClientPorts();

        if (!clients) {
            out.error("lsof could not list connections; nothing stopped and the idle times are left as they were");
            process.exitCode = 1;
            return;
        }

        const { decisions, next } = idleDecisions({
            rows,
            active: (row) => row.port !== null && clients.has(row.port),
            state: await readIdleState(),
            now: Date.now(),
            idleMs: hours * 3_600_000,
        });

        const stoppedIds: string[] = [];
        const failed: string[] = [];

        for (const decision of decisions) {
            const idle = formatDuration(Date.now() - decision.lastActive);
            logger.debug(
                {
                    id: decision.row.id,
                    port: decision.row.port,
                    pids: decision.row.pids,
                    active: decision.active,
                    idleMs: Date.now() - decision.lastActive,
                    stop: decision.stop,
                },
                "services: idle decision"
            );

            if (!decision.stop) {
                out.println(`${decision.row.id}: ${decision.active ? "in use" : `idle ${idle}`}`);
                continue;
            }

            if (options.dryRun) {
                out.println(`${decision.row.id}: idle ${idle}, would stop`);
                continue;
            }

            // A client may have connected since the snapshot (an earlier stop can take 10 s): read again.
            const now = readClientPorts();

            if (!now || (decision.row.port !== null && now.has(decision.row.port))) {
                if (now) {
                    // Used again just now: the idle window starts over instead of keeping the stale time.
                    next[decision.row.id] = Date.now();
                }

                out.println(`${decision.row.id}: ${now ? "a client connected, kept" : "connections unreadable, kept"}`);
                continue;
            }

            const stopped = await stopService(decision.row);
            out.println(`${decision.row.id}: idle ${idle}, ${stopped.message}`);

            if (stopped.ok) {
                logger.debug({ id: decision.row.id, idle, message: stopped.message }, "services: idle stop");
                stoppedIds.push(decision.row.id);
            } else {
                logger.warn({ id: decision.row.id, idle, message: stopped.message }, "services: idle stop failed");
                failed.push(decision.row.id);
            }
        }

        if (!options.dryRun) {
            await writeIdleState(next);
        }

        logger.debug(
            {
                services: rows.length,
                considered: decisions.length,
                inUse: decisions.filter((decision) => decision.active).length,
                stopped: stoppedIds,
                failed,
                dryRun: options.dryRun === true,
            },
            "services: reap-idle done"
        );

        if (stoppedIds.length > 0) {
            const message = `${formatList(stoppedIds)}: no client for ${hours} h.`;

            try {
                await sendNotification({ title: "Idle servers stopped", message, group: IDLE_TASK });
                logger.debug({ stopped: stoppedIds }, "services: idle stop notification sent");
            } catch (error) {
                logger.warn({ error, stopped: stoppedIds }, "services: idle stop notification failed");
            }
        }
    });

const idle = program.command("idle").description("The daemon task that runs reap-idle every 15 minutes");

idle.command("install")
    .description("Register the daemon task (tools daemon must be installed)")
    .option("--idle-hours <hours>", "Hours without a connected client", String(DEFAULT_IDLE_HOURS))
    .action(async (options: { idleHours: string }) => {
        const hours = Number(options.idleHours);

        if (!Number.isFinite(hours) || hours <= 0) {
            out.error(`--idle-hours must be a positive number, got ${options.idleHours}`);
            process.exitCode = 1;
            return;
        }

        await registerTask({
            name: IDLE_TASK,
            command: `tools services reap-idle --idle-hours ${hours}`,
            every: "every 15 minutes",
            retries: 0,
            // The reaper notifies when it stops a server; a banner per 15-minute run is noise.
            notify: "failure",
            description: "Stop on-demand GenesisTools servers nobody used for a while",
            overwrite: true,
        });
        logger.debug({ task: IDLE_TASK, idleHours: hours }, "services: idle task registered");
        out.println(`Registered ${IDLE_TASK}: every 15 minutes, idle after ${hours} h`);
    });

idle.command("uninstall")
    .description("Remove the daemon task")
    .action(async () => {
        const removed = await unregisterTask(IDLE_TASK);
        logger.debug({ task: IDLE_TASK, removed }, "services: idle task unregistered");
        out.println(removed ? `Removed ${IDLE_TASK}` : `${IDLE_TASK} was not registered`);
    });

idle.command("status")
    .description("Whether the daemon task is registered")
    .action(async () => {
        out.println(
            (await isTaskRegistered(IDLE_TASK)) ? `${IDLE_TASK} is registered` : `${IDLE_TASK} is not registered`
        );
    });

await runTool(program, { tool: "services" });
