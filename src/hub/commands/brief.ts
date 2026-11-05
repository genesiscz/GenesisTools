import { registerTask, unregisterTask } from "@app/daemon/lib/register";
import type { MorningBriefDto } from "@app/dev-dashboard/contract/brief";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import { renderCliHeader, renderCliKeyRow, renderCliSection } from "@genesiscz/utils/table";
import { type Command, InvalidArgumentError } from "commander";
import {
    BRIEF_TASK_NAME,
    type BriefConfig,
    buildBrief,
    pushBrief,
    readBrief,
    readBriefConfig,
    storeBrief,
    writeBriefConfig,
} from "../lib/brief/index";

function clockArg(value: string): string {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        throw new InvalidArgumentError('a local time as "HH:MM"');
    }

    return value;
}

function hoursArg(value: string): number {
    const hours = Number(value);

    if (!Number.isFinite(hours) || hours < 0.5 || hours > 24) {
        throw new InvalidArgumentError("hours between 0.5 and 24");
    }

    return hours;
}

function clock(iso: string | null | undefined): string {
    return iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "-";
}

function renderBrief(brief: MorningBriefDto): void {
    renderCliHeader("Morning brief", `built ${new Date(brief.generatedAt).toLocaleString("en-GB")}`);

    if (brief.commute) {
        renderCliSection("Commute");
        renderCliKeyRow("Trip", `${brief.commute.from} → ${brief.commute.to}`);
        renderCliKeyRow(
            "Leave",
            brief.commute.error
                ? brief.commute.error
                : `${clock(brief.commute.leaveAt)}, ${brief.commute.minutes} min, arrive ${clock(brief.commute.arriveAt)}`
        );
    }

    if (brief.weather) {
        renderCliSection("Weather");
        renderCliKeyRow(brief.weather.label, `${brief.weather.tempC ?? "-"} °C, ${brief.weather.description}`);
    }

    if (brief.overnight) {
        renderCliSection("Overnight");
        renderCliKeyRow("Sessions", String(brief.overnight.sessions));
        renderCliKeyRow("Commits", String(brief.overnight.commits));
        renderCliKeyRow("Decisions answered", String(brief.overnight.decisionsAnswered));

        for (const title of brief.overnight.titles) {
            renderCliKeyRow("", title);
        }
    }

    renderCliSection("Waiting");
    renderCliKeyRow("Decisions", brief.decisionsWaiting === null ? "-" : String(brief.decisionsWaiting));

    if (brief.resets.length > 0) {
        renderCliSection("Short windows");

        for (const reset of brief.resets) {
            renderCliKeyRow(
                `${reset.provider} ${reset.account}`,
                `${reset.utilization} %, resets ${clock(reset.resetsAt)}`
            );
        }
    }

    for (const warning of brief.warnings) {
        out.log.warn(warning);
    }
}

/**
 * `tools hub brief`: the stored morning brief (F29), as the phone shows it (`/api/gateway/brief`). `--refresh` builds
 * it now (ONE Waze call), `--push` sends it to the phone. `brief config` sets the trip and the times; `brief schedule`
 * registers the daily daemon task.
 */
export function registerBriefCommand(program: Command): void {
    const brief = program
        .command("brief")
        .description("The morning brief: when to leave, the weather, the night's work, waiting decisions, resets")
        .option("--refresh", "build it now (asks Waze once) and store it")
        .option("--push", "send the brief to the phone")
        .option("--json", "machine-readable output")
        .action(async (opts: { refresh?: boolean; push?: boolean; json?: boolean }) => {
            let result = readBrief();

            if (opts.refresh) {
                result = await buildBrief({ config: await readBriefConfig() });
                storeBrief(result);
            }

            if (!result) {
                opts.json ? out.result(null) : out.println("No brief has been built yet. Use --refresh to build one.");
                return;
            }

            if (opts.push) {
                const sent = await pushBrief(result);
                process.exitCode = sent ? 0 : 1;
            }

            if (opts.json) {
                out.result(result);
                return;
            }

            renderBrief(result);
        });

    brief
        .command("config")
        .description("Set the commute and the times the brief uses; with no option it prints the config")
        .option("--from <place>", "where the commute starts")
        .option("--to <place>", "where the commute ends")
        .option("--leave-after <HH:MM>", "the earliest departure", clockArg)
        .option("--window <hours>", "how many hours of departures Waze compares", hoursArg)
        .option("--no-commute", "ask Waze nothing")
        .option("--at <HH:MM>", "when the daemon task builds the brief", clockArg)
        .option("--since <HH:MM>", "when the overnight window starts on the day before", clockArg)
        .option("--json", "machine-readable output")
        .action(
            async (opts: {
                from?: string;
                to?: string;
                leaveAfter?: string;
                window?: number;
                commute?: boolean;
                at?: string;
                since?: string;
                json?: boolean;
            }) => {
                const current = await readBriefConfig();
                const trip = current.commute;
                const changesTrip = Boolean(opts.from || opts.to || opts.leaveAfter || opts.window !== undefined);
                const next: BriefConfig = {
                    schedule: { at: opts.at ?? current.schedule.at },
                    overnight: { since: opts.since ?? current.overnight.since },
                    commute:
                        opts.commute === false
                            ? null
                            : changesTrip
                              ? {
                                    from: opts.from ?? trip?.from ?? "",
                                    to: opts.to ?? trip?.to ?? "",
                                    leaveAfter: opts.leaveAfter ?? trip?.leaveAfter ?? "07:00",
                                    windowHours: opts.window ?? trip?.windowHours ?? 2,
                                }
                              : trip,
                };
                const changed = changesTrip || opts.commute === false || opts.at || opts.since;
                const saved = changed ? await writeBriefConfig(next) : current;

                if (opts.json) {
                    out.result(saved);
                    return;
                }

                renderCliHeader("Morning brief config", changed ? "saved" : "current");
                renderCliKeyRow(
                    "Commute",
                    saved.commute
                        ? `${saved.commute.from} → ${saved.commute.to}, after ${saved.commute.leaveAfter}, ${saved.commute.windowHours} h`
                        : "none"
                );
                renderCliKeyRow("Built at", saved.schedule.at);
                renderCliKeyRow("Overnight since", saved.overnight.since);

                if (opts.at) {
                    out.log.info(
                        `Run ${toolCommand("hub brief schedule")} again so the daemon task moves to ${opts.at}`
                    );
                }
            }
        );

    brief
        .command("schedule")
        .description("Register the daily daemon task that builds the brief and pushes it to the phone")
        .action(async () => {
            const config = await readBriefConfig();
            const written = await registerTask({
                name: BRIEF_TASK_NAME,
                command: toolCommand("hub brief", "--refresh", "--push", "--json"),
                every: `every day at ${config.schedule.at}`,
                overwrite: true,
                notify: "failure",
                // No retry: a second run is a second Waze call, and Waze blocks an IP after about 200 of them.
                retries: 0,
                timeoutMs: 5 * 60_000,
                description: `The morning brief for the phone (${toolCommand("hub brief")})`,
            });
            out.log.info(
                written
                    ? `${BRIEF_TASK_NAME} runs every day at ${config.schedule.at}`
                    : `${BRIEF_TASK_NAME} was not changed`
            );
        });

    brief
        .command("unschedule")
        .description("Remove the daily daemon task")
        .action(async () => {
            const removed = await unregisterTask(BRIEF_TASK_NAME);
            out.log.info(removed ? `${BRIEF_TASK_NAME} removed` : `${BRIEF_TASK_NAME} was not registered`);
        });
}
