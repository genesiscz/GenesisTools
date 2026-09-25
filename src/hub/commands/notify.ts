import { resolve } from "node:path";
import { isTaskRegistered, registerTask, unregisterTask } from "@app/daemon/lib/register";
import { out } from "@genesiscz/utils/logger";
import { dispatchNotification } from "@genesiscz/utils/notifications";
import { shellCommandLine } from "@genesiscz/utils/shell/quote";
import { createBoxTable, formatDotStatus, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import {
    daemonEvery,
    NOTIFY_EVENT_LABELS,
    NOTIFY_EVENTS,
    type NotifyEvent,
    type NotifySettingsChange,
    notifyConfigPath,
    parseIntervalFlag,
    readNotifyConfig,
    updateNotifyConfig,
} from "../lib/notify-config";
import { hubPrRef, notifyStatus, type PollReport, pollNotify, testNotification } from "../lib/notify-poll";
import { isHubPrRef } from "../lib/pr-ref";

export const NOTIFY_TASK_NAME = "hub-pr-notify";
const DAEMON_SCRIPT = resolve(import.meta.dir, "../lib/notify-daemon.ts");

function onOff(value: string, flag: string): boolean {
    if (value === "on" || value === "true") {
        return true;
    }

    if (value === "off" || value === "false") {
        return false;
    }

    throw new Error(`${flag} takes on or off, got ${value}`);
}

/** `thread=on,ciPassed=off` into switches; an unknown event name is an error that lists the names. */
function parseEvents(values: string[]): Partial<Record<NotifyEvent, boolean>> {
    const events: Partial<Record<NotifyEvent, boolean>> = {};

    for (const pair of values.flatMap((value) => value.split(","))) {
        const [name, state = "on"] = pair.split("=");

        if (!(NOTIFY_EVENTS as readonly string[]).includes(name)) {
            throw new Error(`unknown event "${name}"; events: ${NOTIFY_EVENTS.join(", ")}`);
        }

        events[name as NotifyEvent] = onOff(state, `--event ${name}`);
    }

    return events;
}

function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

function pollLines(report: PollReport): string {
    if (report.skipped) {
        return `Skipped: ${report.skipped}`;
    }

    return [
        ...report.repos.map(
            (repo) =>
                `${repo.key.padEnd(40)} ${repo.skipped ?? repo.error ?? `${repo.prs} PRs, ${repo.requests} requests, ${repo.ms} ms`}`
        ),
        ...report.items.map((item) => `→ ${item.type.padEnd(9)} ${hubPrRef(item)} ${item.message}`),
        `${report.items.length} events, ${report.posted} posted${report.dryRun ? " (dry run: nothing posted or saved)" : ""}, ${report.requests} requests, ${report.elapsedMs} ms`,
    ].join("\n");
}

async function daemonRegistered(): Promise<boolean | null> {
    try {
        return await isTaskRegistered(NOTIFY_TASK_NAME);
    } catch (err) {
        out.log.warn(`daemon config unreadable: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}

/** The daemon task runs one poll per interval; the poll itself skips a run that is not due. */
async function registerDaemonTask(intervalMinutes: number): Promise<void> {
    await registerTask({
        name: NOTIFY_TASK_NAME,
        command: shellCommandLine([Bun.which("bun") ?? "bun", "run", DAEMON_SCRIPT]),
        every: daemonEvery(intervalMinutes),
        retries: 0,
        timeoutMs: 120_000,
        description: "Poll the hub's watched PRs/MRs and post notifications (tools hub notify)",
        overwrite: true,
        notify: false,
    });
}

export function registerNotifyCommands(program: Command): void {
    const notify = program
        .command("notify")
        .description(
            "PR/MR notifications: new review threads, CI failed or passed, a review bot finished, merged. Config in ~/.genesis-tools/hub/notify.json"
        );

    notify
        .command("status", { isDefault: true })
        .description("The config, the last poll, each repo's backoff, the request rate and the recent events")
        .option("--json", "machine-readable output")
        .action(async (opts: { json?: boolean }) => {
            const status = notifyStatus({ configPath: notifyConfigPath(), daemonTask: await daemonRegistered() });

            if (opts.json) {
                out.result(status);
                return;
            }

            renderCliHeader("Hub notifications", status.config.enabled ? "on" : "off");
            const table = createBoxTable(["REPO", "WATCHED", "LAST OK", "STATE"]);

            for (const [path, repo] of Object.entries(status.config.repos)) {
                table.push([path, formatDotStatus(repo.enabled ? "ok" : "dim", repo.enabled ? "on" : "off"), "", ""]);
            }

            for (const [key, repo] of Object.entries(status.repos)) {
                table.push([
                    key,
                    "",
                    repo.lastOkAt ?? "never",
                    repo.lastError
                        ? formatDotStatus("err", `${repo.failures} failures, next ${repo.nextAt}`)
                        : formatDotStatus("ok", "ok"),
                ]);
            }

            out.println(table.toString());
            out.println(
                [
                    `Events: ${NOTIFY_EVENTS.map((e) => `${e}=${status.config.events[e] ? "on" : "off"}`).join(" ")}`,
                    `Only my PRs: ${status.config.onlyMine ? "yes" : "no"} · every ${status.config.intervalMinutes} min`,
                    `Last poll: ${status.lastPollAt ?? "never"} · ${status.pollsLastHour} polls and ${status.requestsLastHour} host requests in the last hour`,
                    `Daemon task ${NOTIFY_TASK_NAME}: ${status.daemonTask === null ? "unknown" : status.daemonTask ? "registered" : "not registered (tools hub notify install)"}`,
                    ...status.recent
                        .slice(0, 5)
                        .map((event) => `  ${event.at} ${event.type} ${hubPrRef(event)} ${event.message}`),
                ].join("\n")
            );
        });

    notify
        .command("set")
        .description("Change the config: master switch, interval, only my PRs, event switches (global or per repo)")
        .option("--enabled <on|off>", "the master switch")
        .option("--interval <minutes>", "minutes between polls (1 to 60)")
        .option("--only-mine <on|off>", "only PRs/MRs I opened")
        .option("--event <name=on|off>", `an event switch, repeatable: ${NOTIFY_EVENTS.join(", ")}`, collect)
        .option("--repo <path>", "scope --event to this checkout, and the one --repo-enabled switches")
        .option("--repo-enabled <on|off>", "watch --repo or stop watching it")
        .option("--reset-repo-events", "--repo follows the global event switches again")
        .option("--bots <logins>", "comma-separated logins that count as review bots besides the host's bot accounts")
        .option("--json", "print the new config as JSON")
        .action(
            async (opts: {
                enabled?: string;
                interval?: string;
                onlyMine?: string;
                event?: string[];
                repo?: string;
                repoEnabled?: string;
                resetRepoEvents?: boolean;
                bots?: string;
                json?: boolean;
            }) => {
                let change: NotifySettingsChange;

                try {
                    const interval = opts.interval === undefined ? undefined : parseIntervalFlag(opts.interval);

                    if ((opts.repoEnabled !== undefined || opts.resetRepoEvents) && !opts.repo) {
                        throw new Error("--repo-enabled and --reset-repo-events need --repo <path>");
                    }

                    change = {
                        enabled: opts.enabled === undefined ? undefined : onOff(opts.enabled, "--enabled"),
                        intervalMinutes: interval,
                        onlyMine: opts.onlyMine === undefined ? undefined : onOff(opts.onlyMine, "--only-mine"),
                        events: opts.event ? parseEvents(opts.event) : undefined,
                        repo: opts.repo ? resolve(opts.repo) : undefined,
                        repoEnabled:
                            opts.repoEnabled === undefined ? undefined : onOff(opts.repoEnabled, "--repo-enabled"),
                        resetRepoEvents: opts.resetRepoEvents,
                        botLogins: opts.bots?.split(","),
                    };
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    out.log.error(message);
                    process.exitCode = 1;
                    return;
                }

                const next = await updateNotifyConfig(change);

                // The daemon task's cadence follows the interval, when the task exists.
                if (change.intervalMinutes !== undefined && (await daemonRegistered())) {
                    await registerDaemonTask(next.intervalMinutes);
                }

                if (opts.json) {
                    out.result(next);
                    return;
                }

                out.log.success(`Saved ${notifyConfigPath()}`);
            }
        );

    notify
        .command("poll")
        .description("One poll now: fetch the watched repos, compare with the last poll, post what changed")
        .option("--force", "poll even when not due, and ignore every backoff")
        .option("--dry-run", "fetch and compare only: post nothing and save nothing")
        .option("--json", "machine-readable output")
        .action(async (opts: { force?: boolean; dryRun?: boolean; json?: boolean }) => {
            const report = await pollNotify({ force: opts.force, dryRun: opts.dryRun });

            if (opts.json) {
                out.result(report);
                return;
            }

            out.println(pollLines(report));
        });

    notify
        .command("test")
        .description("Post one test notification (marked as a test) whose click opens the hub at a PR")
        .option("--pr <ref>", "the PR the click opens: 42 or owner/repo#42", "")
        .action(async (opts: { pr: string }) => {
            const pr = opts.pr.trim() || null;

            if (pr && !isHubPrRef(pr)) {
                out.log.error(`--pr takes 42, #42, owner/repo#42 or group/app!12, got ${opts.pr}`);
                process.exitCode = 1;
                return;
            }

            const delivered = await dispatchNotification(testNotification(pr));
            out.log[delivered ? "success" : "error"](
                delivered ? "Test notification posted" : "The notification was not delivered"
            );
            process.exitCode = delivered ? 0 : 1;
        });

    notify
        .command("install")
        .description(`Register the daemon task ${NOTIFY_TASK_NAME} (one poll per interval, under tools daemon)`)
        .action(async () => {
            const config = readNotifyConfig();
            await registerDaemonTask(config.intervalMinutes);
            out.log.success(`Registered ${NOTIFY_TASK_NAME}: every ${config.intervalMinutes} min`);
            out.log.info("The daemon picks it up on its next config read; tools daemon status lists it.");
        });

    notify
        .command("uninstall")
        .description(`Remove the daemon task ${NOTIFY_TASK_NAME}`)
        .action(async () => {
            const removed = await unregisterTask(NOTIFY_TASK_NAME);
            out.log.info(removed ? `Removed ${NOTIFY_TASK_NAME}` : `${NOTIFY_TASK_NAME} was not registered`);
        });

    notify
        .command("events")
        .description("The event names and what each one posts")
        .action(() => {
            out.println(NOTIFY_EVENTS.map((event) => `${event.padEnd(10)} ${NOTIFY_EVENT_LABELS[event]}`).join("\n"));
        });
}
