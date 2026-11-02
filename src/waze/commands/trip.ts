import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { abortableSleep } from "@genesiscz/utils/async";
import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { logger, out } from "@genesiscz/utils/logger";
import { sendNotification } from "@genesiscz/utils/macos/notifications";
import type { Command } from "commander";
import pc from "picocolors";
import { scanCorridor } from "../lib/corridor";
import { navigateLink } from "../lib/deeplinks";
import { EXPORT_FORMATS, isExportFormat } from "../lib/export";
import { corridorAlertsTable, kmText } from "../lib/format";
import { findOperation, newReports, reportLine, USER_REPORTS_HIDDEN_NOTICE } from "../lib/operations";
import { resolvePlace } from "../lib/places";
import { planRoute } from "../lib/routing";
import type { AlertCategory } from "../lib/types";
import { parseInterval } from "../lib/when";
import {
    errorMessage,
    globalOptions,
    openContext,
    parseIntArg,
    pickCategories,
    printResult,
    runOperation,
    TOOL,
} from "./run";

interface TripFlags {
    corridor?: number;
    vignette?: boolean;
}

function tripInput(from: string, to: string, flags: TripFlags): Record<string, unknown> {
    return { from, to, corridorM: flags.corridor, vignette: flags.vignette };
}

function withTripFlags(command: Command): Command {
    return command
        .option("--corridor <metres>", "How far from the route a report may be (default 150)", parseIntArg)
        .option("--no-vignette", "Plan without vignette motorways (Waze's no-vignette routes)");
}

export function registerTripCommands(program: Command): void {
    withTripFlags(
        program
            .command("police <from> <to>")
            .description("Police reports along a whole trip, with km markers from the start and the age of each report")
    ).action(async (from: string, to: string, flags: TripFlags, command: Command) => {
        await runOperation(command, "police", tripInput(from, to, flags));
    });

    withTripFlags(
        program
            .command("route <from> <to>")
            .description("ETA, distance and alternatives, plus every report and jam on the route corridor")
            .option("--alternatives", "Also list Waze's no-vignette alternatives")
            .option(
                "--type [types]",
                "Only these report types (comma list): police, accident, hazard, jam, closure, camera, other"
            )
            .option("--at <when>", 'Departure: now, HH:MM, "tomorrow HH:MM" or an ISO date-time')
    ).action(
        async (
            from: string,
            to: string,
            flags: TripFlags & { alternatives?: boolean; type?: string | boolean; at?: string },
            command: Command
        ) => {
            const types = await pickCategories({ given: flags.type, subcommand: "route" });
            if (types === null) {
                return;
            }

            await runOperation(command, "route", {
                ...tripInput(from, to, flags),
                alternatives: flags.alternatives,
                types,
                at: flags.at,
            });
        }
    );

    program
        .command("depart <from> <to>")
        .description("Best departure time: Waze's predicted drive time for each 15-minute departure in a window")
        .option("--at <when>", 'Earliest departure: now (default), HH:MM, "tomorrow HH:MM" or ISO')
        .option("--window <hours>", "Hours of departures to compare (default 4)", Number)
        .option("--no-vignette", "Plan without vignette motorways")
        .action(
            async (
                from: string,
                to: string,
                flags: { at?: string; window?: number; vignette?: boolean },
                command: Command
            ) => {
                await runOperation(command, "depart", {
                    from,
                    to,
                    at: flags.at,
                    windowHours: flags.window,
                    vignette: flags.vignette,
                });
            }
        );

    withTripFlags(
        program
            .command("export <from> <to>")
            .description("The route with its reports and jams as GeoJSON, GPX, KML or CSV")
            .option("--format [format]", `Output format: ${EXPORT_FORMATS.join(", ")} (default geojson)`)
            .option("-o, --output <file>", "Write to a file instead of stdout")
            .option("--type [types]", "Only these report types (comma list)")
    ).action(
        async (
            from: string,
            to: string,
            flags: TripFlags & { format?: string | boolean; output?: string; type?: string | boolean },
            command: Command
        ) => {
            const format = await pickEnumFlag({
                tool: `${TOOL} export`,
                subcommand: ["export"],
                flag: "--format",
                given: flags.format,
                values: EXPORT_FORMATS,
                fallback: "geojson",
                accepts: isExportFormat,
            });
            const types = await pickCategories({ given: flags.type, subcommand: "export" });
            if (!format || types === null) {
                return;
            }

            const ctx = openContext(command);
            try {
                const result = await withInterrupt(() =>
                    findOperation("export").run(ctx, { ...tripInput(from, to, flags), format, types })
                );
                const data = result.data;
                const content =
                    typeof data === "object" && data !== null && "content" in data && typeof data.content === "string"
                        ? data.content
                        : result.markdown;
                // Incomplete coverage goes to stderr, so a file or a piped stdout stays a valid document.
                const warnings =
                    typeof data === "object" && data !== null && "warnings" in data && Array.isArray(data.warnings)
                        ? data.warnings.filter((warning): warning is string => typeof warning === "string")
                        : [];
                for (const warning of warnings) {
                    out.log.warn(warning);
                }
                if (flags.output) {
                    const path = resolve(flags.output);
                    writeFileSync(path, content);
                    out.log.success(`Wrote ${format} to ${path}`);
                    return;
                }

                if (globalOptions(command).json) {
                    printResult(command, result);
                    return;
                }

                out.print(content);
            } catch (error) {
                logger.debug({ error }, "waze export failed");
                out.log.error(errorMessage(error));
                process.exitCode = 1;
            } finally {
                await ctx.close();
            }
        }
    );

    withTripFlags(
        program
            .command("watch <from> <to>")
            .description("Poll the trip corridor and notify on each new police or accident report (Ctrl-C to stop)")
            .option("--interval <time>", "Time between polls: 90s, 2m, 1h (default 2m)", "2m")
            .option("--type [types]", "Report types that notify (comma list, default police,accident)")
            .option("--count <n>", "Stop after this many polls", parseIntArg)
            .option("--say", "Also speak each notification")
            .option("--no-notify", "Print only, no macOS notification")
    ).action(
        async (
            from: string,
            to: string,
            flags: TripFlags & {
                interval: string;
                type?: string | boolean;
                count?: number;
                say?: boolean;
                notify?: boolean;
            },
            command: Command
        ) => {
            const intervalMs = parseInterval(flags.interval);
            if (intervalMs === undefined || intervalMs < 30_000) {
                out.log.error(`--interval must be at least 30s, got "${flags.interval}"`);
                process.exitCode = 1;
                return;
            }

            const picked = await pickCategories({ given: flags.type, subcommand: "watch" });
            if (picked === null) {
                return;
            }

            const types: AlertCategory[] = picked ?? ["police", "accident"];
            await watchTrip(command, { from, to, flags, intervalMs, types });
        }
    );
}

async function watchTrip(
    command: Command,
    opts: {
        from: string;
        to: string;
        intervalMs: number;
        types: AlertCategory[];
        flags: TripFlags & { count?: number; say?: boolean; notify?: boolean };
    }
): Promise<void> {
    const ctx = openContext(command);
    const json = globalOptions(command).json === true;
    try {
        await withInterrupt(async (signal) => {
            const client = await ctx.client();
            const from = await resolvePlace({ query: opts.from, client });
            const to = await resolvePlace({ query: opts.to, client, near: from });
            const planned = await planRoute({
                client,
                from,
                to,
                vignette: opts.flags.vignette ?? true,
                alternatives: false,
            });
            const route = planned.routes[0];
            if (!route) {
                throw new Error("No route found");
            }

            out.log.info(
                `Watching ${from.label} → ${to.label} (${route.name}, ${kmText(route.distanceM)}${planned.fallbackReason ? ", OSRM route" : ""}) for ${opts.types.join(", ")} every ${Math.round(opts.intervalMs / 1000)} s. Ctrl-C stops.`
            );
            if (client.transport.info().userReportsHidden === true) {
                out.log.warn(USER_REPORTS_HIDDEN_NOTICE);
            }

            const seen = new Set<string>();
            for (let poll = 1; !signal.aborted; poll++) {
                try {
                    const result = await scanCorridor({
                        client,
                        line: route.coords,
                        corridorM: opts.flags.corridor,
                        feedTypes: ["alerts"],
                    });
                    const fresh = newReports({ alerts: result.alerts, seen, types: opts.types });
                    const now = Date.now();
                    for (const alert of result.alerts) {
                        seen.add(alert.id);
                    }

                    if (json) {
                        out.result({ poll, at: now, new: fresh, onRoute: result.alerts.length, stats: result.stats });
                    } else if (fresh.length > 0) {
                        out.println(
                            `${pc.bold(new Date(now).toLocaleTimeString("cs-CZ"))} ${fresh.length} new on the route:`
                        );
                        out.println(corridorAlertsTable(fresh, now));
                    } else {
                        out.log.step(
                            `${new Date(now).toLocaleTimeString("cs-CZ")} poll ${poll}: nothing new (${result.alerts.length} reports on the route)`
                        );
                    }

                    if (fresh.length > 0 && poll > 1 && opts.flags.notify !== false) {
                        await notifyReports({ fresh, now, to, say: opts.flags.say === true });
                    }
                } catch (error) {
                    logger.warn({ error, poll }, "waze watch poll failed");
                    out.log.warn(`poll ${poll} failed: ${errorMessage(error)}`);
                }

                if (opts.flags.count !== undefined && poll >= opts.flags.count) {
                    break;
                }

                await abortableSleep(opts.intervalMs, signal).catch((error: unknown) => {
                    logger.debug({ error }, "waze watch sleep ended");
                });
            }
        });
    } catch (error) {
        logger.debug({ error }, "waze watch failed");
        out.log.error(errorMessage(error));
        process.exitCode = 1;
    } finally {
        await ctx.close();
    }
}

async function notifyReports(opts: {
    fresh: ReturnType<typeof newReports>;
    now: number;
    to: { lat: number; lon: number };
    say: boolean;
}): Promise<void> {
    const first = opts.fresh[0];
    if (!first) {
        return;
    }

    const title =
        opts.fresh.length === 1
            ? `Waze: ${first.category} on your route`
            : `Waze: ${opts.fresh.length} new reports on your route`;
    try {
        await sendNotification({
            title,
            message: opts.fresh.map((alert) => reportLine(alert, opts.now)).join("\n"),
            group: "waze-watch",
            open: navigateLink(opts.to),
            say: opts.say,
        });
    } catch (error) {
        logger.warn({ error }, "waze watch notification failed");
    }
}
