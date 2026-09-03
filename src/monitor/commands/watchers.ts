import { muteUntilFrom } from "@app/monitor/commands/extras";
import { runAddWizard } from "@app/monitor/commands/interactive";
import { runCheck } from "@app/monitor/lib/checks/run-check";
import { Monitor } from "@app/monitor/lib/monitor";
import { findPreset, WATCHER_PRESETS } from "@app/monitor/lib/presets";
import {
    type CheckResult,
    DEFAULT_INTERVAL_SEC,
    DEFAULT_TIMEOUT_MS,
    WATCHER_KINDS,
    type Watcher,
    type WatcherInput,
    type WatcherKind,
    type WatcherStatus,
} from "@app/monitor/lib/types";
import { parseWatcherInput, parseWatcherPatch, WatcherValidationError } from "@app/monitor/lib/validate";
import { concurrentMap } from "@genesiscz/utils/async";
import { isInteractive, suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { formatRelativeTime } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { parseSqliteOrIsoDate } from "@genesiscz/utils/sql-time";
import {
    createBoxTable,
    formatDotStatus,
    renderCliHeader,
    renderCliSection,
    truncateDisplay,
} from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

interface AddOptions {
    name?: string;
    /** `true` when `--kind` was passed without a value (commander optional-value flag). */
    kind?: string | true;
    preset?: string;
    interval?: string;
    timeout?: string;
    expectStatus?: string;
    expectBody?: string;
    degradedMs?: string;
    components?: string;
    itemFilter?: string;
    expectIp?: string;
    jsonPath?: string;
    expect?: string;
    warnDays?: string;
    minDays?: string;
    mute?: string;
    deliver: boolean;
    targets?: string;
    notify: boolean;
    paused?: boolean;
    json?: boolean;
}

interface EditOptions {
    name?: string;
    interval?: string;
    timeout?: string;
    expectStatus?: string;
    expectBody?: string;
    degradedMs?: string;
    components?: string;
    itemFilter?: string;
    expectIp?: string;
    jsonPath?: string;
    expect?: string;
    warnDays?: string;
    minDays?: string;
    mute?: string;
    deliver?: boolean;
    targets?: string;
    notify?: boolean;
    json?: boolean;
}

const STATUS_DOT: Record<WatcherStatus, Parameters<typeof formatDotStatus>[0]> = {
    up: "ok",
    degraded: "warn",
    down: "err",
    unknown: "dim",
};

function statusCell(status: WatcherStatus): string {
    return formatDotStatus(STATUS_DOT[status], status);
}

function ago(value: string | null): string {
    const date = parseSqliteOrIsoDate(value);

    return date ? formatRelativeTime(date) : "never";
}

function latency(value: number | null): string {
    return value === null ? "—" : `${value} ms`;
}

/** `--limit` as a whole number between 1 and 500; anything else is the default. */
function parseLimit(raw: string, fallback: number): number {
    const value = Number.parseInt(raw, 10);

    return Number.isInteger(value) && value > 0 ? Math.min(value, 500) : fallback;
}

function parseId(raw: string): number {
    const id = Number.parseInt(raw, 10);

    if (!Number.isInteger(id) || id <= 0) {
        throw new WatcherValidationError(`"${raw}" is not a watcher id`);
    }

    return id;
}

function guessKind(target: string): WatcherKind {
    if (target.startsWith("acc_")) {
        return "ai-provider";
    }

    if (/\.(rss|atom|xml)(\?|$)/i.test(target) || /\/(feed|rss|atom)(\/|\?|$)/i.test(target)) {
        return "rss";
    }

    if (/^(https?:\/\/)?(www\.)?status\./i.test(target) || /status\.[a-z]+$/i.test(target.replace(/\/$/, ""))) {
        return "statuspage";
    }

    return "website";
}

function defaultName(kind: WatcherKind, target: string): string {
    if (kind === "ai-provider") {
        return target;
    }

    try {
        return new URL(/^https?:\/\//i.test(target) ? target : `https://${target}`).host;
    } catch {
        return target;
    }
}

/** Only flags that were passed; a spread of `undefined` would erase preset values. */
function configFromFlags(opts: Partial<EditOptions>, base: Record<string, unknown> = {}): Record<string, unknown> {
    const config: Record<string, unknown> = { ...base };
    const flagged: Array<[string, unknown]> = [
        ["expectStatus", opts.expectStatus],
        ["expectBody", opts.expectBody],
        ["degradedAboveMs", opts.degradedMs],
        ["components", opts.components],
        ["itemFilter", opts.itemFilter],
        ["deliverItems", opts.deliver],
        ["expectIp", opts.expectIp],
        ["jsonPath", opts.jsonPath],
        ["expect", opts.expect],
        ["warnDays", opts.warnDays],
        ["minDays", opts.minDays],
    ];

    for (const [key, value] of flagged) {
        if (value !== undefined) {
            config[key] = value;
        }
    }

    return config;
}

function buildInput(target: string, opts: AddOptions): WatcherInput {
    const preset = opts.preset ? findPreset(opts.preset) : undefined;

    if (opts.preset && !preset) {
        throw new WatcherValidationError(`unknown preset "${opts.preset}"; run: tools monitor presets`);
    }

    const rawKind = typeof opts.kind === "string" ? opts.kind : (preset?.kind ?? guessKind(target));

    if (!(WATCHER_KINDS as readonly string[]).includes(rawKind)) {
        throw new WatcherValidationError(`kind must be one of ${WATCHER_KINDS.join(", ")}`);
    }

    const kind = rawKind as WatcherKind;

    return parseWatcherInput({
        name: opts.name ?? preset?.name ?? defaultName(kind, target),
        kind,
        target,
        config: configFromFlags(opts, { ...preset?.config }),
        intervalSec: opts.interval ?? preset?.intervalSec ?? DEFAULT_INTERVAL_SEC,
        timeoutMs: opts.timeout ?? DEFAULT_TIMEOUT_MS,
        enabled: !opts.paused,
        notify: opts.notify,
        targetIds: opts.targets,
        mutedUntil: opts.mute ? muteUntilFrom(opts.mute) : undefined,
    });
}

export function printWatchers(watchers: Watcher[]): void {
    renderCliHeader("Monitor watchers", `${watchers.length} configured`);
    const table = createBoxTable([
        "ID",
        "STATUS",
        "NAME",
        "KIND",
        "TARGET",
        "EVERY",
        "LATENCY",
        "CHECKED",
        "NOTIFY",
        "DETAIL",
    ]);

    for (const watcher of watchers) {
        table.push([
            pc.white(String(watcher.id)),
            watcher.enabled ? statusCell(watcher.lastStatus) : formatDotStatus("dim", "paused"),
            pc.white(truncateDisplay(watcher.name, 24)),
            watcher.kind,
            truncateDisplay(watcher.target, 34),
            `${watcher.intervalSec}s`,
            latency(watcher.lastLatencyMs),
            ago(watcher.lastCheckedAt),
            !watcher.notify
                ? pc.dim("off")
                : watcher.targetIds.length > 0
                  ? `#${watcher.targetIds.join(",#")}`
                  : "defaults",
            truncateDisplay(watcher.lastDetail ?? "", 36),
        ]);
    }

    out.println(table.toString());
    renderCliSection("Next");
    out.println(`  ${suggestCommand("tools monitor", { replaceCommand: ["add", "<url>"] })}`);
    out.println(`  ${suggestCommand("tools monitor", { replaceCommand: ["edit", "<id>", "--targets", "1,2"] })}`);
    out.println(`  ${suggestCommand("tools monitor", { replaceCommand: ["check"] })}`);
}

function printCheck(label: string, result: CheckResult): void {
    out.println(`${statusCell(result.status)}  ${pc.white(label)}  ${pc.dim(result.detail)}`);
}

const CLI_CONCURRENCY = 8;

/** Bounded fan-out, in input order: a long watcher list must not open every socket at once. */
async function mapWatchers<T>(watchers: Watcher[], fn: (watcher: Watcher) => Promise<T>): Promise<T[]> {
    const results = await concurrentMap({
        items: watchers,
        fn,
        concurrency: CLI_CONCURRENCY,
        onError: (watcher, error) => {
            throw error instanceof Error ? error : new Error(`${watcher.name}: ${String(error)}`);
        },
    });

    return watchers.flatMap((watcher) => (results.has(watcher) ? [results.get(watcher) as T] : []));
}

async function withMonitor<T>(fn: (monitor: Monitor) => Promise<T>): Promise<T> {
    const monitor = new Monitor();

    try {
        return await fn(monitor);
    } finally {
        monitor.close();
    }
}

async function requireWatcher(monitor: Monitor, raw: string): Promise<Watcher> {
    const watcher = await monitor.getWatcher(parseId(raw));

    if (!watcher) {
        throw new WatcherValidationError(`no watcher with id ${raw}; run: tools monitor list`);
    }

    return watcher;
}

function commonFlags(command: Command): Command {
    return command
        .option("-i, --interval <seconds>", "Seconds between checks")
        .option("-t, --timeout <ms>", "Request timeout in ms")
        .option("--expect-status <code>", "website: HTTP status that counts as up (default: any < 400)")
        .option("--expect-body <text>", "website: body must contain this text")
        .option("--degraded-ms <ms>", "website/ai-provider: slower than this is degraded")
        .option("--components <names>", "statuspage: comma-separated component names to watch")
        .option("--item-filter <words>", "rss: only items whose title/summary contains one of these words")
        .option("--expect-ip <address>", "dns: the host must resolve to this address")
        .option("--json-path <path>", "json: dot path into the document (status.indicator, items[0].id)")
        .option("--expect <value>", "json: the value at --json-path must equal this (as text)")
        .option("--warn-days <n>", "tls: degraded when fewer days remain (default 14)")
        .option("--min-days <n>", "tls: down when fewer days remain (default 0)")
        .option("--mute <duration>", "Silence notifications for 30m, 2h, 1d, …")
        .option("--targets <ids>", "Notification targets from the library, comma-separated ids (empty = defaults)")
        .option("--json", "Emit JSON");
}

export function registerWatcherCommands(program: Command): void {
    commonFlags(
        program
            .command("add")
            .description(
                "Add a watcher. No target in a terminal = guided wizard. Kinds: website, statuspage, rss, tcp, dns, tls, json, command, ai-provider"
            )
            .argument("[target]", "URL, status page, feed URL, host:port, hostname, shell command or acc_… account id")
            .option("-n, --name <name>", "Display name (default: host or preset name)")
            .option("-k, --kind [kind]", `One of ${WATCHER_KINDS.join(", ")} (default: guessed from the target)`)
            .option("-p, --preset <id>", "Start from a preset (see: tools monitor presets)")
            .option("--no-deliver", "rss: record new items without delivering them")
            .option("--no-notify", "Do not send notifications on state changes or new items")
            .option("--paused", "Create the watcher disabled")
    ).action(async (target: string | undefined, opts: AddOptions) => {
        if (target === undefined) {
            if (!isInteractive()) {
                out.error("target is required in non-interactive mode.");
                out.println(
                    suggestCommand("tools monitor", {
                        replaceCommand: ["add", "https://example.com", "--name", "Example"],
                    })
                );
                process.exitCode = 1;

                return;
            }

            await withMonitor((monitor) => runAddWizard(monitor));

            return;
        }

        if (opts.kind === true || (opts.kind && !(WATCHER_KINDS as readonly string[]).includes(opts.kind))) {
            out.println(suggestEnumFlag("tools monitor add", "--kind", [...WATCHER_KINDS]));
            process.exitCode = 1;

            return;
        }

        const input = buildInput(target, opts);
        const outcome = await withMonitor(async (monitor) => {
            const watcher = await monitor.createWatcher(input);
            const run = await monitor.runWatcher(watcher);

            return { watcher: run?.watcher ?? watcher, check: run?.check ?? null };
        });

        if (opts.json) {
            out.result(outcome);

            return;
        }

        out.log.success(`Added watcher #${outcome.watcher.id} "${outcome.watcher.name}" (${outcome.watcher.kind})`);

        if (outcome.check) {
            printCheck(outcome.watcher.name, outcome.check);
        }
    });

    commonFlags(
        program
            .command("edit")
            .description("Change a watcher's name, schedule, thresholds or notification targets")
            .argument("<id>", "Watcher id")
            .option("-n, --name <name>", "New display name")
            .option("--deliver", "rss: deliver new items")
            .option("--no-deliver", "rss: stop delivering new items")
            .option("--notify", "Send notifications")
            .option("--no-notify", "Mute this watcher")
    ).action(async (id: string, opts: EditOptions) => {
        const watcher = await withMonitor(async (monitor) => {
            const current = await requireWatcher(monitor, id);
            const config = configFromFlags(opts);
            const patch = parseWatcherPatch(
                {
                    name: opts.name,
                    intervalSec: opts.interval,
                    timeoutMs: opts.timeout,
                    config: Object.keys(config).length > 0 ? { ...current.config, ...config } : undefined,
                    notify: opts.notify,
                    targetIds: opts.targets,
                    mutedUntil: opts.mute ? muteUntilFrom(opts.mute) : undefined,
                },
                current.kind
            );

            if (Object.keys(patch).length === 0) {
                throw new WatcherValidationError("nothing to change; pass at least one flag");
            }

            return monitor.updateWatcher(current.id, patch);
        });

        if (opts.json) {
            out.result({ watcher });

            return;
        }

        out.log.success(`Updated watcher #${id} "${watcher?.name ?? ""}"`);
    });

    program
        .command("list")
        .alias("ls")
        .description("List watchers with their last status")
        .option("--json", "Emit JSON")
        .action(async (opts: { json?: boolean }) => {
            const watchers = await withMonitor((monitor) =>
                opts.json ? monitor.db.summarizeAll() : monitor.listWatchers()
            );

            if (opts.json) {
                out.result({ watchers });

                return;
            }

            if (watchers.length === 0) {
                out.log.info("No watchers yet.");
                out.println(suggestCommand("tools monitor", { replaceCommand: ["add", "https://example.com"] }));
                out.println(
                    suggestCommand("tools monitor", {
                        replaceCommand: ["add", "--preset", "claude-status", "status.claude.com"],
                    })
                );

                return;
            }

            printWatchers(watchers);
        });

    program
        .command("check")
        .description("Probe watchers and report. Reads only: nothing is recorded and nobody is notified.")
        .argument("[id]", "Watcher id")
        .option("--url <target>", "Ad-hoc target to probe without saving a watcher")
        .option("-k, --kind <kind>", "Kind for --url (default: guessed)")
        .option("--json", "Emit JSON")
        .action(async (id: string | undefined, opts: { url?: string; kind?: string; json?: boolean }) => {
            if (opts.url) {
                const input = buildInput(opts.url, { kind: opts.kind, notify: true, deliver: true });
                const check = await runCheck(input);

                if (opts.json) {
                    out.result({ target: input, check });
                } else {
                    printCheck(input.name, check);
                }

                process.exitCode = check.status === "down" ? 2 : 0;

                return;
            }

            // `check` inspects. It calls runCheck directly rather than
            // monitor.runWatcher, which records rows, opens and closes
            // incidents, delivers feed items and pages the user's phone.
            // `tools monitor run` is the verb that does all of that.
            const probes = await withMonitor(async (monitor) => {
                const targets = id
                    ? [await requireWatcher(monitor, id)]
                    : await monitor.listWatchers({ enabledOnly: true });

                return mapWatchers(targets, async (watcher) => ({
                    watcher,
                    check: await runCheck(watcher),
                    saved: false,
                }));
            });

            if (opts.json) {
                out.result({ probes });

                return;
            }

            for (const probe of probes) {
                printCheck(`#${probe.watcher.id} ${probe.watcher.name}`, probe.check);

                if (probe.check.status !== probe.watcher.lastStatus) {
                    out.println(`    ${pc.yellow("would change")} ${probe.watcher.lastStatus} → ${probe.check.status}`);
                }
            }

            if (probes.length > 0) {
                out.println(pc.dim("Nothing was recorded. To record and notify:"));
                out.println(suggestCommand("tools monitor", { replaceCommand: id ? ["run", id] : ["run"] }));
            }

            process.exitCode = probes.some((probe) => probe.check.status === "down") ? 2 : 0;
        });

    program
        .command("run")
        .description("Run checks now and record them: status, incidents, feed items and notifications.")
        .argument("[id]", "Watcher id")
        .option("--json", "Emit JSON")
        .action(async (id: string | undefined, opts: { json?: boolean }) => {
            const outcomes = await withMonitor(async (monitor) => {
                const targets = id
                    ? [await requireWatcher(monitor, id)]
                    : await monitor.listWatchers({ enabledOnly: true });
                const results = await mapWatchers(targets, (watcher) => monitor.runWatcher(watcher));

                return results.filter((outcome): outcome is NonNullable<typeof outcome> => outcome !== null);
            });

            if (opts.json) {
                out.result({ results: outcomes });

                return;
            }

            for (const outcome of outcomes) {
                printCheck(`#${outcome.watcher.id} ${outcome.watcher.name}`, outcome.check);

                for (const item of outcome.newItems) {
                    out.println(`    ${pc.cyan("new")} ${item.title}${item.link ? pc.dim(` ${item.link}`) : ""}`);
                }
            }

            process.exitCode = outcomes.some((outcome) => outcome.check.status === "down") ? 2 : 0;
        });

    program
        .command("items")
        .description("rss: show the items a feed watcher has seen")
        .argument("<id>", "Watcher id")
        .option("--limit <n>", "Max rows", "20")
        .option("--json", "Emit JSON")
        .action(async (id: string, opts: { limit: string; json?: boolean }) => {
            const { watcher, items } = await withMonitor(async (monitor) => {
                const current = await requireWatcher(monitor, id);

                return {
                    watcher: current,
                    items: await monitor.db.listFeedItems(current.id, parseLimit(opts.limit, 20)),
                };
            });

            if (opts.json) {
                out.result({ items });

                return;
            }

            renderCliHeader(watcher.name, `${items.length} item${items.length === 1 ? "" : "s"}`);
            const table = createBoxTable(["WHEN", "SENT", "TITLE", "LINK"]);

            for (const item of items) {
                table.push([
                    ago(item.publishedAt ?? item.seenAt),
                    item.delivered ? formatDotStatus("ok", "yes") : formatDotStatus("dim", "no"),
                    pc.white(truncateDisplay(item.title, 60)),
                    truncateDisplay(item.link ?? "", 50),
                ]);
            }

            out.println(table.toString());
        });

    program
        .command("rm")
        .alias("remove")
        .description("Delete a watcher and its history")
        .argument("<id>", "Watcher id")
        .action(async (id: string) => {
            const name = await withMonitor(async (monitor) => {
                const watcher = await requireWatcher(monitor, id);
                await monitor.deleteWatcher(watcher.id);

                return watcher.name;
            });
            out.log.success(`Deleted watcher #${id} "${name}"`);
        });

    for (const [verb, enabled] of [
        ["enable", true],
        ["disable", false],
    ] as const) {
        program
            .command(verb)
            .description(enabled ? "Resume a paused watcher" : "Pause a watcher (keeps history)")
            .argument("<id>", "Watcher id")
            .action(async (id: string) => {
                const watcher = await withMonitor(async (monitor) => {
                    const current = await requireWatcher(monitor, id);

                    return monitor.updateWatcher(current.id, { enabled });
                });
                out.log.success(`${enabled ? "Enabled" : "Paused"} watcher #${id} "${watcher?.name ?? ""}"`);
            });
    }

    program
        .command("presets")
        .description("List one-click watcher presets")
        .option("--json", "Emit JSON")
        .action((opts: { json?: boolean }) => {
            if (opts.json) {
                out.result({ presets: WATCHER_PRESETS });

                return;
            }

            renderCliHeader("Watcher presets", "tools monitor add --preset <id> <target>");
            const table = createBoxTable(["ID", "KIND", "TARGET", "DESCRIPTION"]);

            for (const preset of WATCHER_PRESETS) {
                table.push([pc.white(preset.id), preset.kind, preset.target, truncateDisplay(preset.description, 60)]);
            }

            out.println(table.toString());
        });

    program
        .command("incidents")
        .description("List incidents (open first)")
        .option("--open", "Only open incidents")
        .option("--limit <n>", "Max rows", "50")
        .option("--json", "Emit JSON")
        .action(async (opts: { open?: boolean; limit: string; json?: boolean }) => {
            const incidents = await withMonitor((monitor) =>
                monitor.db.listIncidents({ openOnly: opts.open, limit: parseLimit(opts.limit, 50) })
            );

            if (opts.json) {
                out.result({ incidents });

                return;
            }

            if (incidents.length === 0) {
                out.log.info(opts.open ? "No open incidents." : "No incidents recorded.");

                return;
            }

            renderCliHeader("Incidents", `${incidents.length} shown`);
            const table = createBoxTable(["ID", "STATUS", "WATCHER", "STARTED", "ENDED", "DETAIL"]);

            for (const incident of incidents) {
                table.push([
                    String(incident.id),
                    statusCell(incident.status),
                    pc.white(truncateDisplay(incident.watcherName, 24)),
                    ago(incident.startedAt),
                    incident.endedAt ? ago(incident.endedAt) : pc.yellow("open"),
                    truncateDisplay(incident.detail, 50),
                ]);
            }

            out.println(table.toString());
        });
}
