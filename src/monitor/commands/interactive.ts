import { collectStatus, printStatus, printWatcherDetail, statusCell, withMonitor } from "@app/monitor/commands/extras";
import { printTargets } from "@app/monitor/commands/targets";
import { monitorUiApp } from "@app/monitor/commands/ui";
import { printWatchers } from "@app/monitor/commands/watchers";
import type { Monitor } from "@app/monitor/lib/monitor";
import { WATCHER_PRESETS } from "@app/monitor/lib/presets";
import { DEFAULT_INTERVAL_SEC, WATCHER_KINDS, type WatcherInput, type WatcherKind } from "@app/monitor/lib/types";
import { normalizeTarget, parseWatcherInput, WatcherValidationError } from "@app/monitor/lib/validate";
import * as p from "@clack/prompts";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import pc from "picocolors";

const KIND_HINTS: Record<WatcherKind, { label: string; hint: string; placeholder: string }> = {
    website: { label: "Website", hint: "HTTP status, body text, latency", placeholder: "https://example.com" },
    statuspage: {
        label: "Status page",
        hint: "Statuspage / incident.io / status.x.ai data",
        placeholder: "status.claude.com",
    },
    rss: {
        label: "RSS / Atom feed",
        hint: "new items delivered to your targets",
        placeholder: "https://status.x.ai/feed.xml",
    },
    tcp: { label: "TCP port", hint: "a port answers a connect", placeholder: "db.example.com:5432" },
    dns: { label: "DNS", hint: "host resolves, optionally to one address", placeholder: "example.com" },
    tls: { label: "TLS certificate", hint: "valid chain, days until expiry", placeholder: "example.com:443" },
    json: { label: "JSON API", hint: "a JSON path equals a value", placeholder: "https://api.example.com/health" },
    command: { label: "Shell command", hint: "exit 0 means up", placeholder: "pg_isready -h db.local" },
    "ai-provider": { label: "AI provider account", hint: "provider health probe", placeholder: "acc_…" },
};

const INTERVALS: Array<{ value: string; label: string }> = [
    { value: "30", label: "30 seconds" },
    { value: "60", label: "1 minute" },
    { value: "120", label: "2 minutes" },
    { value: "300", label: "5 minutes" },
    { value: "900", label: "15 minutes" },
    { value: "3600", label: "1 hour" },
];

function cancelled(value: unknown): boolean {
    if (p.isCancel(value)) {
        p.cancel("Cancelled");

        return true;
    }

    return false;
}

/**
 * Prompted `add`: kind, target, name, interval, library targets, notify. Ends
 * with the same create + first check the non-interactive `add` runs.
 */
export async function runAddWizard(monitor: Monitor, initialTarget?: string): Promise<boolean> {
    p.intro(pc.bgCyan(pc.black(" tools monitor add ")));

    const preset = await p.select({
        message: "Start from a preset?",
        options: [
            { value: "", label: "No, custom watcher" },
            ...WATCHER_PRESETS.map((entry) => ({ value: entry.id, label: entry.name, hint: entry.description })),
        ],
    });

    if (cancelled(preset)) {
        return false;
    }

    const chosen = WATCHER_PRESETS.find((entry) => entry.id === preset);
    let kind: WatcherKind = chosen?.kind ?? "website";

    if (!chosen) {
        const picked = await p.select({
            message: "What do you want to watch?",
            options: WATCHER_KINDS.map((value) => ({
                value,
                label: KIND_HINTS[value].label,
                hint: KIND_HINTS[value].hint,
            })),
            initialValue: kind,
        });

        if (cancelled(picked)) {
            return false;
        }

        kind = picked as WatcherKind;
    }

    const target = await p.text({
        message: kind === "command" ? "Command to run" : "Target",
        placeholder: KIND_HINTS[kind].placeholder,
        initialValue: initialTarget ?? chosen?.target ?? "",
        validate: (value) => {
            try {
                normalizeTarget(kind, value ?? "");

                return undefined;
            } catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
        },
    });

    if (cancelled(target)) {
        return false;
    }

    const normalizedTarget = normalizeTarget(kind, String(target));
    const name = await p.text({
        message: "Name",
        initialValue: chosen?.name ?? defaultName(kind, normalizedTarget),
        validate: (value) => (value?.trim() ? undefined : "a name is required"),
    });

    if (cancelled(name)) {
        return false;
    }

    const interval = await p.select({
        message: "Check every",
        options: INTERVALS,
        initialValue: String(chosen?.intervalSec ?? DEFAULT_INTERVAL_SEC),
    });

    if (cancelled(interval)) {
        return false;
    }

    const config: Record<string, unknown> = { ...chosen?.config };

    if (kind === "json") {
        const jsonPath = await p.text({
            message: "JSON path (empty = whole document)",
            placeholder: "status.indicator",
        });

        if (cancelled(jsonPath)) {
            return false;
        }

        const expect = await p.text({
            message: "Expected value (empty = path only has to exist)",
            placeholder: "none",
        });

        if (cancelled(expect)) {
            return false;
        }

        config.jsonPath = String(jsonPath ?? "");
        config.expect = String(expect ?? "");
    }

    if (kind === "statuspage") {
        const components = await p.text({
            message: "Only these components (comma-separated, empty = whole page)",
            placeholder: "Claude API",
            initialValue: chosen?.config?.components?.join(", ") ?? "",
        });

        if (cancelled(components)) {
            return false;
        }

        config.components = String(components ?? "");
    }

    if (kind === "website" || kind === "tcp" || kind === "dns" || kind === "json" || kind === "command") {
        const degraded = await p.text({
            message: "Degraded above (ms, empty = never)",
            placeholder: "2000",
            initialValue: chosen?.config?.degradedAboveMs?.toString() ?? "",
        });

        if (cancelled(degraded)) {
            return false;
        }

        config.degradedAboveMs = String(degraded ?? "");
    }

    const library = await monitor.listTargets();
    let targetIds: number[] = [];

    if (library.length > 0) {
        const picked = await p.multiselect({
            message: "Notify via (none = the defaults from the Notifications page)",
            options: library.map((entry) => ({
                value: String(entry.id),
                label: `${entry.name} (${entry.channel})`,
                hint: entry.enabled ? undefined : "paused",
            })),
            required: false,
        });

        if (cancelled(picked)) {
            return false;
        }

        targetIds = (picked as string[]).map((value) => Number(value));
    }

    const notify = await p.confirm({ message: "Notify on state changes?", initialValue: true });

    if (cancelled(notify)) {
        return false;
    }

    const input: WatcherInput = parseWatcherInput({
        name: String(name),
        kind,
        target: normalizedTarget,
        config,
        intervalSec: String(interval),
        notify: Boolean(notify),
        targetIds,
    });
    const spinner = p.spinner();
    spinner.start("Creating and running the first check");

    try {
        const watcher = await monitor.createWatcher(input);
        const outcome = await monitor.runWatcher(watcher);
        spinner.stop(`Added watcher #${watcher.id} "${watcher.name}"`);

        if (outcome) {
            out.println(
                `${statusCell(outcome.check.status)}  ${pc.white(watcher.name)}  ${pc.dim(outcome.check.detail)}`
            );
        }
    } catch (error) {
        spinner.stop("Failed");
        logger.debug({ error }, "monitor wizard: create failed");
        out.error(error instanceof Error ? error.message : String(error));

        return false;
    }

    p.outro(pc.green("Done"));

    return true;
}

function defaultName(kind: WatcherKind, target: string): string {
    if (kind === "ai-provider" || kind === "command") {
        return target.slice(0, 40);
    }

    try {
        return new URL(/^https?:\/\//i.test(target) ? target : `https://${target}`).host;
    } catch {
        return target;
    }
}

/** `tools monitor` with no arguments in a terminal: a small menu over the same verbs. */
export async function runInteractiveMenu(): Promise<void> {
    if (!isInteractive()) {
        out.println(suggestCommand("tools monitor", { replaceCommand: ["--help"] }));

        return;
    }

    p.intro(pc.bgCyan(pc.black(" tools monitor ")));

    while (true) {
        const action = await p.select({
            message: "What now?",
            options: [
                { value: "status", label: "Status", hint: "server, counts, open incidents" },
                { value: "list", label: "List watchers" },
                { value: "show", label: "Show one watcher" },
                { value: "add", label: "Add a watcher", hint: "guided" },
                { value: "run", label: "Run every check now" },
                { value: "targets", label: "Notification library" },
                { value: "open", label: "Open the dashboard" },
                { value: "exit", label: "Exit" },
            ],
        });

        if (p.isCancel(action) || action === "exit") {
            p.outro(pc.green("Bye"));

            return;
        }

        try {
            await withMonitor(async (monitor) => {
                switch (action) {
                    case "status":
                        printStatus(await collectStatus(monitor));
                        break;
                    case "list":
                        printWatchers(await monitor.listWatchers());
                        break;
                    case "show": {
                        const watchers = await monitor.listWatchers();

                        if (watchers.length === 0) {
                            out.log.info("No watchers yet.");
                            break;
                        }

                        const id = await p.select({
                            message: "Which watcher?",
                            options: watchers.map((watcher) => ({
                                value: String(watcher.id),
                                label: `#${watcher.id} ${watcher.name}`,
                                hint: `${watcher.kind} · ${watcher.lastStatus}`,
                            })),
                        });

                        if (p.isCancel(id)) {
                            break;
                        }

                        const watcher = watchers.find((entry) => String(entry.id) === id);

                        if (watcher) {
                            await printWatcherDetail(monitor, await monitor.db.summarize(watcher));
                        }

                        break;
                    }
                    case "add":
                        await runAddWizard(monitor);
                        break;
                    case "run": {
                        const spinner = p.spinner();
                        spinner.start("Running every enabled watcher");
                        const watchers = await monitor.listWatchers({ enabledOnly: true });
                        const outcomes = await Promise.all(watchers.map((watcher) => monitor.runWatcher(watcher)));
                        spinner.stop(`${outcomes.filter(Boolean).length} checks done`);

                        for (const outcome of outcomes) {
                            if (outcome) {
                                out.println(
                                    `${statusCell(outcome.check.status)}  ${pc.white(outcome.watcher.name)}  ${pc.dim(outcome.check.detail)}`
                                );
                            }
                        }

                        break;
                    }
                    case "targets":
                        printTargets(await monitor.listTargets());
                        break;
                    case "open":
                        await monitorUiApp.open();
                        break;
                    default:
                        break;
                }
            });
        } catch (error) {
            if (error instanceof WatcherValidationError) {
                out.error(error.message);
            } else {
                throw error;
            }
        }
    }
}
