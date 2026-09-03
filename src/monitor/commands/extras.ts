import { existsSync, statSync } from "node:fs";
import { monitorUiApp } from "@app/monitor/commands/ui";
import { Monitor } from "@app/monitor/lib/monitor";
import { CHANNEL_NAMES, getNotifySettings } from "@app/monitor/lib/notify-settings";
import { describeTarget } from "@app/monitor/lib/notify-targets";
import { monitorServerApp } from "@app/monitor/lib/server/app";
import {
    type FeedItem,
    isMuted,
    type MonitorEvent,
    maskTarget,
    maskWatcher,
    type NotifyTarget,
    type Watcher,
    type WatcherStatus,
    type WatcherSummary,
} from "@app/monitor/lib/types";
import {
    normalizeTarget,
    parseEntityId,
    parseNotifyTargetInput,
    parseWatcherInput,
    WatcherValidationError,
} from "@app/monitor/lib/validate";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { formatDuration, formatRelativeTime, parseDuration } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { parseSqliteOrIsoDate } from "@genesiscz/utils/sql-time";
import {
    createBoxTable,
    formatDotStatus,
    renderCliHeader,
    renderCliKeyRow,
    renderCliSection,
    truncateDisplay,
} from "@genesiscz/utils/table";
import { WEB_SERVICES } from "@genesiscz/utils/ui/dashboards";
import type { Command } from "commander";
import pc from "picocolors";

const STATUS_DOT: Record<WatcherStatus, Parameters<typeof formatDotStatus>[0]> = {
    up: "ok",
    degraded: "warn",
    down: "err",
    unknown: "dim",
};

export function statusCell(status: WatcherStatus): string {
    return formatDotStatus(STATUS_DOT[status], status);
}

function ago(value: string | null): string {
    const date = parseSqliteOrIsoDate(value);

    return date ? formatRelativeTime(date) : "never";
}

function pct(value: number | null): string {
    return value === null ? "—" : `${(value * 100).toFixed(value < 0.99 ? 1 : 2)}%`;
}

function latency(value: number | null): string {
    return value === null ? "—" : `${value} ms`;
}

export async function withMonitor<T>(fn: (monitor: Monitor) => Promise<T>): Promise<T> {
    const monitor = new Monitor();

    try {
        return await fn(monitor);
    } finally {
        await monitor.close();
    }
}

async function requireWatcher(monitor: Monitor, raw: string): Promise<Watcher> {
    const watcher = await monitor.getWatcher(parseEntityId(raw));

    if (!watcher) {
        throw new WatcherValidationError(`no watcher with id ${raw}; run: tools monitor list`);
    }

    return watcher;
}

/** `2h`, `45m`, `1d`, or bare minutes, as an ISO time from now. */
export function muteUntilFrom(duration: string): string {
    return new Date(Date.now() + requireDuration(duration)).toISOString();
}

/** `parseDuration` answers 0 for anything it cannot read, which would silently mean "since now". */
function requireDuration(duration: string): number {
    let ms: number;

    try {
        ms = parseDuration(duration);
    } catch (error) {
        logger.debug({ error, duration }, "monitor: bad duration");
        throw new WatcherValidationError(`"${duration}" is not a duration (try 30m, 2h, 1d)`);
    }

    if (!Number.isFinite(ms) || ms <= 0) {
        throw new WatcherValidationError(`"${duration}" is not a duration (try 30m, 2h, 1d)`);
    }

    return ms;
}

// ------------------------------------------------------------------ show

export async function printWatcherDetail(monitor: Monitor, raw: WatcherSummary): Promise<void> {
    // `summarize()` hands back the stored watcher, so an `Authorization` header
    // would be printed in full by the Config row below.
    const summary = maskWatcher(raw);
    const targets = summary.targetIds.length > 0 ? await monitor.db.getTargets(summary.targetIds) : [];
    const checks = await monitor.db.listChecks(summary.id, { limit: 5 });

    renderCliHeader(`#${summary.id} ${summary.name}`, `${summary.kind} · ${summary.target}`);
    renderCliKeyRow("Status", `${statusCell(summary.lastStatus)}  ${pc.dim(summary.lastDetail ?? "")}`);
    renderCliKeyRow("Checked", `${ago(summary.lastCheckedAt)} · latency ${latency(summary.lastLatencyMs)}`);
    renderCliKeyRow(
        "Uptime",
        `24h ${pct(summary.uptime24h)} · 7d ${pct(summary.uptime7d)} · 30d ${pct(summary.uptime30d)} · avg ${latency(summary.avgLatency24h)} over ${summary.checks24h} checks`
    );
    renderCliKeyRow(
        "Schedule",
        `every ${summary.intervalSec}s, timeout ${summary.timeoutMs} ms, ${summary.enabled ? "enabled" : pc.yellow("paused")}`
    );
    renderCliKeyRow(
        "Notify",
        !summary.notify
            ? pc.dim("off")
            : isMuted(summary)
              ? pc.yellow(`muted until ${summary.mutedUntil}`)
              : targets.length > 0
                ? targets.map((target) => `#${target.id} ${target.name} (${target.channel})`).join(", ")
                : "defaults"
    );

    const config = Object.entries(summary.config).filter(([, value]) => value !== undefined);

    if (config.length > 0) {
        renderCliKeyRow(
            "Config",
            config.map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`).join("  ")
        );
    }

    if (summary.openIncident) {
        renderCliKeyRow(
            "Incident",
            `${pc.yellow(summary.openIncident.status)} since ${ago(summary.openIncident.startedAt)} · ${summary.openIncident.detail}`
        );
    }

    if (checks.length > 0) {
        renderCliSection("Last checks");
        const table = createBoxTable(["WHEN", "STATUS", "LATENCY", "DETAIL"]);

        for (const check of checks) {
            table.push([
                ago(check.checkedAt),
                statusCell(check.status),
                latency(check.latencyMs),
                truncateDisplay(check.detail, 70),
            ]);
        }

        out.println(table.toString());
    }

    renderCliSection("Next");
    out.println(`  ${suggestCommand("tools monitor", { replaceCommand: ["history", String(summary.id)] })}`);
    out.println(
        `  ${suggestCommand("tools monitor", { replaceCommand: ["edit", String(summary.id), "--interval", "300"] })}`
    );
}

// ------------------------------------------------------------------ status

export interface MonitorStatusReport {
    server: { running: boolean; pid?: number; port: number; uptimeMs?: number; launchdInstalled: boolean };
    ui: { running: boolean; pid?: number; port: number };
    dbPath: string;
    counts: {
        total: number;
        up: number;
        degraded: number;
        down: number;
        unknown: number;
        paused: number;
        muted: number;
    };
    openIncidents: Array<{ id: number; watcherName: string; status: string; startedAt: string; detail: string }>;
    nextDue: Array<{ id: number; name: string; dueInSec: number }>;
}

export async function collectStatus(monitor: Monitor): Promise<MonitorStatusReport> {
    const [server, ui, overview] = await Promise.all([
        monitorServerApp.status(),
        monitorUiApp.status(),
        monitor.overview(),
    ]);
    const now = Date.now();
    const nextDue = overview.watchers
        .filter((watcher) => watcher.enabled)
        .map((watcher) => {
            const last = parseSqliteOrIsoDate(watcher.lastCheckedAt)?.getTime() ?? 0;

            return {
                id: watcher.id,
                name: watcher.name,
                dueInSec: Math.max(0, Math.round((last + watcher.intervalSec * 1000 - now) / 1000)),
            };
        })
        .sort((a, b) => a.dueInSec - b.dueInSec)
        .slice(0, 5);

    return {
        server: {
            running: server.running,
            pid: server.pid,
            port: server.port,
            uptimeMs: server.uptimeMs,
            launchdInstalled: server.launchdInstalled,
        },
        ui: { running: ui.running, pid: ui.pid, port: ui.port },
        dbPath: monitor.db.path,
        counts: { ...overview.counts, muted: overview.watchers.filter((watcher) => isMuted(watcher)).length },
        openIncidents: overview.openIncidents.map((incident) => ({
            id: incident.id,
            watcherName: incident.watcherName,
            status: incident.status,
            startedAt: incident.startedAt,
            detail: incident.detail,
        })),
        nextDue,
    };
}

export function printStatus(report: MonitorStatusReport): void {
    renderCliHeader("Monitor status", report.dbPath);
    renderCliKeyRow(
        "Server",
        report.server.running
            ? `${formatDotStatus("ok", "running")} pid ${report.server.pid} on :${report.server.port}${report.server.uptimeMs ? ` · up ${formatDuration(report.server.uptimeMs)}` : ""}${report.server.launchdInstalled ? " · launchd" : ""}`
            : `${formatDotStatus("err", "stopped")}  ${pc.dim("start: tools monitor server up")}`
    );
    renderCliKeyRow(
        "Dashboard",
        report.ui.running
            ? `${formatDotStatus("ok", "running")} pid ${report.ui.pid} on :${report.ui.port}`
            : `${formatDotStatus("dim", "stopped")}  ${pc.dim("start: tools monitor ui up")}`
    );
    const c = report.counts;
    renderCliKeyRow(
        "Watchers",
        `${c.total} total · ${pc.green(`${c.up} up`)} · ${pc.yellow(`${c.degraded} degraded`)} · ${pc.red(`${c.down} down`)} · ${c.unknown} unknown · ${c.paused} paused · ${c.muted} muted`
    );

    if (report.openIncidents.length > 0) {
        renderCliSection("Open incidents");
        const table = createBoxTable(["ID", "SEVERITY", "WATCHER", "SINCE", "DETAIL"]);

        for (const incident of report.openIncidents) {
            table.push([
                String(incident.id),
                formatDotStatus(incident.status === "down" ? "err" : "warn", incident.status),
                pc.white(truncateDisplay(incident.watcherName, 26)),
                ago(incident.startedAt),
                truncateDisplay(incident.detail, 56),
            ]);
        }

        out.println(table.toString());
    }

    if (report.nextDue.length > 0) {
        renderCliSection("Next due");
        out.println(
            `  ${report.nextDue.map((entry) => `#${entry.id} ${entry.name} in ${entry.dueInSec}s`).join(" · ")}`
        );
    }
}

// ------------------------------------------------------------------ export / import

export interface MonitorExport {
    version: 1;
    exportedAt: string;
    targets: Array<{
        name: string;
        channel: NotifyTarget["channel"];
        config: NotifyTarget["config"];
        enabled: boolean;
    }>;
    watchers: Array<{
        name: string;
        kind: Watcher["kind"];
        target: string;
        config: Watcher["config"];
        intervalSec: number;
        timeoutMs: number;
        enabled: boolean;
        notify: boolean;
        targets: string[];
    }>;
}

export async function buildExport(monitor: Monitor): Promise<MonitorExport> {
    const targets = await monitor.listTargets();
    const byId = new Map(targets.map((target) => [target.id, target.name]));
    const watchers = await monitor.listWatchers();

    return {
        version: 1,
        exportedAt: new Date().toISOString(),
        targets: targets.map((target) => ({
            name: target.name,
            channel: target.channel,
            config: target.config,
            enabled: target.enabled,
        })),
        watchers: watchers.map((watcher) => ({
            name: watcher.name,
            kind: watcher.kind,
            target: watcher.target,
            config: watcher.config,
            intervalSec: watcher.intervalSec,
            timeoutMs: watcher.timeoutMs,
            enabled: watcher.enabled,
            notify: watcher.notify,
            targets: watcher.targetIds.map((id) => byId.get(id)).filter((name): name is string => name !== undefined),
        })),
    };
}

export async function applyImport(
    monitor: Monitor,
    data: MonitorExport
): Promise<{ targetsCreated: number; watchersCreated: number; skipped: number }> {
    if (data.version !== 1 || !Array.isArray(data.watchers)) {
        throw new WatcherValidationError("not a monitor export (expected version 1 with a watchers array)");
    }

    const existingTargets = await monitor.listTargets();
    const targetIdByName = new Map(existingTargets.map((target) => [target.name, target.id]));
    let targetsCreated = 0;

    for (const entry of data.targets ?? []) {
        if (targetIdByName.has(entry.name)) {
            continue;
        }

        const created = await monitor.createTarget(parseNotifyTargetInput(entry));
        targetIdByName.set(created.name, created.id);
        targetsCreated += 1;
    }

    const existing = await monitor.listWatchers();
    const seen = new Set(existing.map((watcher) => `${watcher.kind}\u0000${watcher.target}`));
    let watchersCreated = 0;
    let skipped = 0;

    for (const entry of data.watchers) {
        const target = normalizeTarget(entry.kind, entry.target);

        if (seen.has(`${entry.kind}\u0000${target}`)) {
            skipped += 1;
            continue;
        }

        const targetIds = (entry.targets ?? [])
            .map((name) => targetIdByName.get(name))
            .filter((id): id is number => id !== undefined);
        await monitor.createWatcher(parseWatcherInput({ ...entry, targetIds }));
        seen.add(`${entry.kind}\u0000${target}`);
        watchersCreated += 1;
    }

    logger.info({ targetsCreated, watchersCreated, skipped }, "monitor: import applied");

    return { targetsCreated, watchersCreated, skipped };
}

// ------------------------------------------------------------------ watch (live)

function describeEvent(event: MonitorEvent): string | null {
    const stamp = pc.dim(new Date().toISOString().slice(11, 19));

    switch (event.type) {
        case "watcher:state":
            return `${stamp} ${statusCell(event.to)}  ${pc.white(event.watcher.name)}  ${pc.dim(`${event.from} → ${event.to}`)}  ${event.watcher.lastDetail ?? ""}`;
        case "watcher:checked":
            return `${stamp} ${statusCell(event.check.status)}  ${event.watcher.name}  ${pc.dim(event.check.detail)}`;
        case "feed:items":
            return event.items
                .map(
                    (item: FeedItem) =>
                        `${stamp} ${pc.cyan("item")}  ${event.watcher.name}: ${item.title}${item.link ? pc.dim(` ${item.link}`) : ""}`
                )
                .join("\n");
        case "watcher:created":
            return `${stamp} ${pc.cyan("new")}   ${event.watcher.name} (${event.watcher.kind})`;
        case "watcher:updated":
            return `${stamp} ${pc.cyan("edit")}  ${event.watcher.name}`;
        case "watcher:deleted":
            return `${stamp} ${pc.cyan("gone")}  watcher #${event.watcherId}`;
        default:
            return null;
    }
}

export async function watchEvents(opts: { all: boolean; port: number }): Promise<void> {
    const url = `ws://127.0.0.1:${opts.port}/api/v1/events`;

    await new Promise<void>((resolve) => {
        const socket = new WebSocket(url);
        socket.onopen = () => {
            out.log.info(
                `Live events from ${url} (Ctrl-C to stop)${opts.all ? "" : " · state changes and feed items only, --all for every check"}`
            );
        };
        socket.onmessage = (message) => {
            let event: MonitorEvent;

            try {
                event = SafeJSON.parse(String(message.data), { strict: true }) as MonitorEvent;
            } catch (error) {
                logger.debug({ error }, "monitor watch: unreadable event");

                return;
            }

            if (event.type === "watcher:checked" && !opts.all) {
                return;
            }

            const line = describeEvent(event);

            if (line) {
                out.println(line);
            }
        };
        socket.onerror = () => {
            out.error(`Cannot reach the monitor server at ${url}. Start it with: tools monitor server up`);
            process.exitCode = 1;
            resolve();
        };
        socket.onclose = () => resolve();
        process.once("SIGINT", () => {
            socket.close();
            resolve();
        });
    });
}

// ------------------------------------------------------------------ doctor

export interface DoctorLine {
    level: "ok" | "warn" | "err";
    subject: string;
    detail: string;
    fix?: string;
}

/** Read-only: reports, never repairs. */
export async function runDoctor(monitor: Monitor): Promise<DoctorLine[]> {
    const lines: DoctorLine[] = [];
    const status = await collectStatus(monitor);
    const dbExists = existsSync(monitor.db.path);
    lines.push({
        level: dbExists ? "ok" : "warn",
        subject: "database",
        detail: dbExists
            ? `${monitor.db.path} (${Math.round(statSync(monitor.db.path).size / 1024)} KB)`
            : `${monitor.db.path} not created yet`,
    });
    lines.push(
        status.server.running
            ? { level: "ok", subject: "server", detail: `pid ${status.server.pid} on :${status.server.port}` }
            : {
                  level: "err",
                  subject: "server",
                  detail: "not running; nothing is checked on a schedule",
                  fix: "tools monitor server up",
              }
    );
    lines.push(
        status.server.launchdInstalled
            ? { level: "ok", subject: "launchd", detail: "server survives reboot" }
            : {
                  level: "warn",
                  subject: "launchd",
                  detail: "server is not installed as a launchd agent",
                  fix: "tools monitor server install",
              }
    );
    lines.push(
        status.ui.running
            ? { level: "ok", subject: "dashboard", detail: `on :${status.ui.port}` }
            : { level: "warn", subject: "dashboard", detail: "not running (optional)", fix: "tools monitor ui up" }
    );

    const watchers = await monitor.db.summarizeAll();

    if (watchers.length === 0) {
        lines.push({ level: "warn", subject: "watchers", detail: "none configured", fix: "tools monitor add <url>" });
    } else {
        lines.push({
            level: "ok",
            subject: "watchers",
            detail: `${watchers.length} configured, ${status.counts.paused} paused, ${status.counts.muted} muted`,
        });
    }

    const now = Date.now();

    for (const watcher of watchers) {
        if (!watcher.enabled) {
            continue;
        }

        const last = parseSqliteOrIsoDate(watcher.lastCheckedAt)?.getTime();

        if (status.server.running && last !== undefined && now - last > watcher.intervalSec * 3000) {
            lines.push({
                level: "warn",
                subject: `#${watcher.id} ${watcher.name}`,
                detail: `last checked ${ago(watcher.lastCheckedAt)}, more than 3 intervals ago`,
                fix: `tools monitor run ${watcher.id}`,
            });
        }

        if (
            watcher.lastStatus === "unknown" &&
            watcher.checks24h >= 3 &&
            watcher.recent.every((point) => point.status === "unknown")
        ) {
            lines.push({
                level: "warn",
                subject: `#${watcher.id} ${watcher.name}`,
                detail: `every recent check is unknown: ${watcher.lastDetail ?? "no detail"}`,
                fix: `tools monitor check ${watcher.id}`,
            });
        }
    }

    const settings = await getNotifySettings();
    const enabledDefaults = settings.channels
        .filter((channel) => channel.resolved.enabled === true)
        .map((channel) => channel.name);
    const targets = await monitor.listTargets();
    const usingDefaults = watchers.filter((watcher) => watcher.notify && watcher.targetIds.length === 0).length;

    if (usingDefaults > 0 && enabledDefaults.length === 0) {
        lines.push({
            level: "warn",
            subject: "notifications",
            detail: `${usingDefaults} watcher(s) rely on the defaults but no default channel is enabled`,
            fix: `tools monitor notify set system --enable`,
        });
    } else {
        lines.push({
            level: "ok",
            subject: "notifications",
            detail: `defaults: ${enabledDefaults.join(", ") || "none"} (${CHANNEL_NAMES.length} channels) · library: ${targets.length} target(s)${targets.filter((target) => !target.enabled).length > 0 ? `, ${targets.filter((target) => !target.enabled).length} paused` : ""}`,
        });
    }

    for (const target of targets) {
        if (target.watcherCount === 0) {
            lines.push({
                level: "warn",
                subject: `target #${target.id} ${target.name}`,
                detail: `${describeTarget(target)} is not used by any watcher`,
            });
        }
    }

    return lines;
}

export function printDoctor(lines: DoctorLine[]): void {
    renderCliHeader("Monitor doctor", "read-only; prints the fix, never applies it");

    for (const line of lines) {
        out.println(
            `  ${formatDotStatus(line.level, line.level.padEnd(4))} ${pc.white(line.subject.padEnd(28))} ${line.detail}${line.fix ? pc.dim(`  → ${line.fix}`) : ""}`
        );
    }
}

// ------------------------------------------------------------------ registration

export function registerExtraCommands(program: Command): void {
    program
        .command("show")
        .description("Everything about one watcher: status, uptime windows, config, targets, last checks")
        .argument("<id>", "Watcher id")
        .option("--json", "Emit JSON")
        .action(async (id: string, opts: { json?: boolean }) => {
            await withMonitor(async (monitor) => {
                const watcher = await requireWatcher(monitor, id);
                const summary = await monitor.db.summarize(watcher);

                if (opts.json) {
                    const targets = await monitor.db.getTargets(summary.targetIds);
                    out.result({ watcher: maskWatcher(summary), targets: targets.map(maskTarget) });

                    return;
                }

                await printWatcherDetail(monitor, summary);
            });
        });

    program
        .command("history")
        .description("Recent checks of one watcher")
        .argument("<id>", "Watcher id")
        .option("--limit <n>", "Max rows (1..500)", "30")
        .option("--since <duration>", "Only checks newer than e.g. 2h, 1d")
        .option("--json", "Emit JSON")
        .action(async (id: string, opts: { limit: string; since?: string; json?: boolean }) => {
            const limitValue = Number.parseInt(opts.limit, 10);
            const limit = Number.isInteger(limitValue) && limitValue > 0 ? Math.min(limitValue, 500) : 30;
            const since = opts.since ? new Date(Date.now() - requireDuration(opts.since)).toISOString() : undefined;
            const { watcher, checks } = await withMonitor(async (monitor) => {
                const current = await requireWatcher(monitor, id);

                return { watcher: current, checks: await monitor.db.listChecks(current.id, { limit, since }) };
            });

            if (opts.json) {
                out.result({ checks });

                return;
            }

            renderCliHeader(
                `${watcher.name} · history`,
                `${checks.length} check${checks.length === 1 ? "" : "s"}${since ? ` since ${opts.since}` : ""}`
            );
            const table = createBoxTable(["WHEN", "STATUS", "LATENCY", "HTTP", "DETAIL"]);

            for (const check of checks) {
                table.push([
                    ago(check.checkedAt),
                    statusCell(check.status),
                    latency(check.latencyMs),
                    check.httpStatus === null ? "—" : String(check.httpStatus),
                    truncateDisplay(check.detail, 64),
                ]);
            }

            out.println(table.toString());
        });

    program
        .command("uptime")
        .description("Uptime over 24h / 7d / 30d for every watcher")
        .option("--json", "Emit JSON")
        .action(async (opts: { json?: boolean }) => {
            const watchers = await withMonitor((monitor) => monitor.db.summarizeAll());

            if (opts.json) {
                out.result({
                    watchers: watchers.map((watcher) => ({
                        id: watcher.id,
                        name: watcher.name,
                        uptime24h: watcher.uptime24h,
                        uptime7d: watcher.uptime7d,
                        uptime30d: watcher.uptime30d,
                        avgLatency24h: watcher.avgLatency24h,
                        checks24h: watcher.checks24h,
                    })),
                });

                return;
            }

            renderCliHeader("Uptime", "share of checks that were not down");
            const table = createBoxTable(["ID", "STATUS", "NAME", "24H", "7D", "30D", "AVG LATENCY", "CHECKS 24H"]);

            for (const watcher of watchers) {
                table.push([
                    pc.white(String(watcher.id)),
                    watcher.enabled ? statusCell(watcher.lastStatus) : formatDotStatus("dim", "paused"),
                    pc.white(truncateDisplay(watcher.name, 26)),
                    pct(watcher.uptime24h),
                    pct(watcher.uptime7d),
                    pct(watcher.uptime30d),
                    latency(watcher.avgLatency24h),
                    String(watcher.checks24h),
                ]);
            }

            out.println(table.toString());
        });

    program
        .command("status")
        .description("Server, dashboard, watcher counts, open incidents and what is due next")
        .option("--json", "Emit JSON")
        .action(async (opts: { json?: boolean }) => {
            const report = await withMonitor(collectStatus);

            if (opts.json) {
                out.result(report);

                return;
            }

            printStatus(report);
        });

    program
        .command("mute")
        .description("Silence a watcher's notifications for a while (checks keep running)")
        .argument("<id>", "Watcher id")
        .option("--for <duration>", "How long: 30m, 2h, 1d (default 1h)", "1h")
        .action(async (id: string, opts: { for: string }) => {
            const until = muteUntilFrom(opts.for);
            const watcher = await withMonitor(async (monitor) => {
                const current = await requireWatcher(monitor, id);

                return monitor.updateWatcher(current.id, { mutedUntil: until });
            });
            out.log.success(`Muted #${id} "${watcher?.name ?? ""}" until ${until}`);
        });

    program
        .command("unmute")
        .description("Lift a mute early")
        .argument("<id>", "Watcher id")
        .action(async (id: string) => {
            const watcher = await withMonitor(async (monitor) => {
                const current = await requireWatcher(monitor, id);

                return monitor.updateWatcher(current.id, { mutedUntil: null });
            });
            out.log.success(`Unmuted #${id} "${watcher?.name ?? ""}"`);
        });

    program
        .command("export")
        .description("Dump watchers and notification targets as JSON (stdout, or --out file). Includes target secrets.")
        .option("-o, --out <file>", "Write to a file instead of stdout")
        .action(async (opts: { out?: string }) => {
            const data = await withMonitor(buildExport);
            const text = SafeJSON.stringify(data, { strict: true, indent: 2 });

            if (opts.out) {
                await Bun.write(opts.out, `${text}\n`);
                out.log.success(
                    `Wrote ${data.watchers.length} watchers and ${data.targets.length} targets to ${opts.out}`
                );
                out.log.warn("The file holds notification secrets (bot tokens, webhook URLs). Keep it private.");

                return;
            }

            out.result(data);
        });

    program
        .command("import")
        .description(
            "Create the watchers and targets from an export file; existing ones (same kind + target, same target name) are kept"
        )
        .argument("<file>", "JSON file written by `tools monitor export`")
        .option("--json", "Emit the counts as JSON")
        .action(async (file: string, opts: { json?: boolean }) => {
            const raw = await Bun.file(file).text();
            const data = SafeJSON.parse(raw) as MonitorExport;
            const result = await withMonitor((monitor) => applyImport(monitor, data));

            if (opts.json) {
                out.result(result);

                return;
            }

            out.log.success(
                `Imported ${result.watchersCreated} watcher(s) and ${result.targetsCreated} target(s); ${result.skipped} watcher(s) already existed`
            );
        });

    program
        .command("watch")
        .description("Print live events from the running server: state changes, new feed items (--all: every check)")
        .option("--all", "Also print every completed check")
        .action(async (opts: { all?: boolean }) => {
            await watchEvents({ all: opts.all === true, port: WEB_SERVICES["monitor-server"].port });
        });

    program
        .command("doctor")
        .description("Read-only health report: server, launchd, dashboard, stale watchers, notification wiring")
        .option("--json", "Emit JSON")
        .action(async (opts: { json?: boolean }) => {
            const lines = await withMonitor(runDoctor);

            if (opts.json) {
                out.result({ lines });

                return;
            }

            printDoctor(lines);
            process.exitCode = lines.some((line) => line.level === "err") ? 1 : 0;
        });

    program
        .command("open")
        .description("Open the dashboard in the browser (starts it if needed)")
        .action(async () => {
            if (!isInteractive()) {
                out.println(suggestCommand("tools monitor", { replaceCommand: ["ui", "up"] }));

                return;
            }

            await monitorUiApp.open();
        });
}
