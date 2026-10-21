import type { AgentSessionRow, AgentSessionRowsOptions } from "@app/ai/lib/sessions/agent-session-rows";
import { processExtraUsageNotifications } from "@app/claude/lib/usage/extra-usage-notify";
import { TASK_SIGTERM_CLEANUP_MS } from "@app/daemon/lib/runner";
import { snapshotToAccountUsage } from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/usage";
import { releaseCodexUsageHomes } from "@genesiscz/utils/ai/providers/plugins/openai-sub/usage";
import { touchUsageDaemonHeartbeat } from "@genesiscz/utils/ai/usage-poll/daemon-heartbeat";
import { loadDashboardConfig } from "@genesiscz/utils/ai/usage-poll/dashboard-config";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { NotificationManager } from "@genesiscz/utils/ai/usage-poll/notifications";
import { pollAccounts } from "@genesiscz/utils/ai/usage-poll/poll";
import { usagePollStorage } from "@genesiscz/utils/ai/usage-poll/storage";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/usage-poll/types";
import { execTool } from "@genesiscz/utils/cli";
import { recordRunOnExit } from "@genesiscz/utils/cli/run-record";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { cpuMeta, profiler } from "@genesiscz/utils/profile";
import { setVaultPurpose } from "@genesiscz/utils/security/vault-purpose";

const ANTHROPIC_SUB = "anthropic-sub";
/** The daemon runner kills this task at 60 s (`timeoutMs` in the task log); the tick keeps 10 s of headroom. */
const TICK_BUDGET_MS = 50_000;

/**
 * Every window worth a threshold notification, flattened out of a round.
 *
 * Stale snapshots replay an older fetch and error rows carry nothing, so both are skipped:
 * notifying on a replay re-fires a threshold that was already handled once.
 */
export function notifiableWindows(snapshots: readonly AccountUsageSnapshot[]) {
    const out: Array<{
        accountId: string;
        accountName: string;
        key: string;
        kind: AccountUsageSnapshot["limits"][number]["kind"];
        label: string;
        utilization: number;
        resetsAt: string | null;
    }> = [];

    for (const snapshot of snapshots) {
        if (snapshot.stale || snapshot.error) {
            continue;
        }

        for (const window of snapshot.limits) {
            if (typeof window.percentUsed !== "number" || !Number.isFinite(window.percentUsed)) {
                continue;
            }

            out.push({
                accountId: snapshot.accountId,
                accountName: snapshot.accountName,
                key: window.key,
                kind: window.kind,
                label: window.label,
                utilization: window.percentUsed,
                resetsAt: window.resetsAt ?? null,
            });
        }
    }

    return out;
}

/**
 * Anthropic rows in the shape the claude-only consumers still take: the extra-usage
 * notifier and the warmup rules, neither of which is provider-neutral.
 */
export function anthropicRows(snapshots: readonly AccountUsageSnapshot[]) {
    return snapshots.filter((s) => s.provider === ANTHROPIC_SUB).map(snapshotToAccountUsage);
}

const prof = profiler.scope("ai-usage");

/** The `usage sessions` argv that recomputes `query`. `--journal-only`: these rows go into the cache file, which must
 *  never hold a live tmux tab. */
export function sessionRowsArgv(query: AgentSessionRowsOptions): string[] {
    const argv = ["ai", "usage", "sessions", "--json", "--fresh", "--no-cache-write", "--journal-only"];
    if (query.providers && query.providers.length > 0) {
        argv.push("--provider", ...query.providers);
    }

    for (const [flag, value] of [
        ["--hours", query.hours],
        ["--min", query.minRows],
        ["--limit", query.limit],
    ] as const) {
        if (value !== undefined) {
            argv.push(flag, String(value));
        }
    }

    return argv;
}

/** The rows of a `usage sessions --json` answer, or null when it holds none. */
export function rowsOfAnswer(stdout: string): AgentSessionRow[] | null {
    const parsed: unknown = SafeJSON.parse(stdout, { strict: true });
    const rows = isObject(parsed) ? parsed.rows : null;
    return Array.isArray(rows) ? rows : null;
}

/**
 * Genesis.app asks `usage sessions --json --hours 24 --min 10` every 35 s, and a fresh answer costs about 1.1 s of
 * CPU (1,130 ms median on 2026-10-12, `scripts/benchmarks/agent-sessions/session-listing.ts`): process start, every
 * provider's session discovery, and the row build. This tick is already awake, so it recomputes the last query
 * the CLI asked for and the CLI reads the file. It does nothing until something has asked once, and stops an hour
 * after the last ask, so an idle machine pays nothing.
 *
 * Bounded by what is left of the tick: this walk took up to 52.7 s on 2026-09-29 (p99 24 s), and the runner's
 * 60 s timeout SIGTERMed the tick 20 times that day, losing its "completed" line. A walk cut short leaves the
 * previous file for the next tick. The budget counts from process start, because the runner's clock starts at
 * spawn and on 2026-10-12 the first line of `main` reached it 5-38 s after spawn. Never throws.
 *
 * The walk runs in a child, never in this process: its SQLite reads are synchronous, so on a loaded disk they held
 * the event loop past the budget timer, and the runner SIGTERMed the tick 9 times on 2026-10-21 (twice the SIGTERM
 * handler could not run either, and it took a SIGKILL). A child is killed at the budget, whatever it is doing.
 */
async function refreshSessionRows(): Promise<void> {
    const remainingMs = () => TICK_BUDGET_MS - (Date.now() - performance.timeOrigin);
    const budgetMs = remainingMs();

    try {
        const { refreshSessionRowsCache } = await import("@app/ai/lib/sessions/rows-cache");
        const { callHubServer } = await import("@app/hub/server/client");
        // The resident hub server answers with warm caches (directory walk, metadata, rows); this process
        // starts cold every minute. Its `--fresh` answer is the same `sessionRowsJson` the CLI prints.
        const remote = async (query: AgentSessionRowsOptions): Promise<AgentSessionRow[] | null> => {
            if (query.providers && query.providers.length > 0) {
                return null;
            }

            // Short: a stalled server must not eat the budget the local walk needs (a cold walk is ~2 s CPU).
            const answer = await callHubServer({
                argv: sessionRowsArgv(query),
                timeoutMs: Math.max(1000, Math.min(5_000, budgetMs / 4)),
            });
            if (!answer) {
                // This tick builds the rows itself. A server that is not running is started for the next tick;
                // the hub window is not needed for that (238 of 644 refreshes on 2026-10-12 found no server).
                const { ensureHubServer } = await import("@app/hub/server/ensure");
                logger.debug({ server: await ensureHubServer() }, "[ai-usage] hub server did not answer");
                return null;
            }

            if (answer.exit !== 0) {
                return null;
            }

            try {
                return rowsOfAnswer(answer.stdout);
            } catch (err) {
                logger.debug({ err }, "[ai-usage] hub server rows unreadable; computing locally");
                return null;
            }
        };
        let cut = false;
        const local = async (query: AgentSessionRowsOptions): Promise<AgentSessionRow[]> => {
            const timeout = remainingMs();
            const child = timeout > 0 ? await execTool(sessionRowsArgv(query), { timeout }) : null;
            if (!child || child.timedOut) {
                cut = true;
                throw new Error(`session rows walk passed the tick's budget (${Math.round(budgetMs / 1000)} s left)`);
            }

            const rows = child.success ? rowsOfAnswer(child.stdout) : null;
            if (!rows) {
                throw new Error(`usage sessions exited ${child.exitCode} without rows: ${child.stderr.slice(-300)}`);
            }

            return rows;
        };

        try {
            const outcome = await prof.measureAsync(
                "tick.session-rows",
                () => refreshSessionRowsCache(local, { remote }),
                cpuMeta()
            );
            logger.info(outcome, "[ai-usage] session rows cache");
        } catch (err) {
            if (!cut) {
                throw err;
            }

            // The designed outcome on a loaded machine, not a fault: in all 7 cuts on 2026-10-21 every read was slow
            // (the Claude projects walk 8 to 25 s for 3,600 files, the history catalog 30 to 40 s), while 1,317
            // finished walks that day took under 1 s each.
            logger.info(
                { budgetMs: Math.round(budgetMs) },
                "[ai-usage] session rows walk cut at the tick's budget; the previous rows stay"
            );
        }
    } catch (err) {
        logger.warn({ err }, "[ai-usage] session rows cache refresh failed");
    }
}

async function main(): Promise<void> {
    const startedAt = Date.now();
    // CPU the process spent before `main` (bun start and imports), logged on the setup line: a tick's CPU is
    // start + setup + the phases below, so the lines account for all of it.
    const beforeMain = process.cpuUsage();
    const setupCpu = cpuMeta();
    const endSetup = prof.start("tick.setup", () => ({
        ...setupCpu(),
        beforeMain: `${Math.round((beforeMain.user + beforeMain.system) / 1000)}ms`,
    }));
    logger.info("[ai-usage] daemon poll starting");
    setVaultPurpose("refresh the usage of every AI account (the usage daemon, once a minute in the background)");

    const dashConfig = await loadDashboardConfig();
    const db = new UsageLimitsDb();
    const notifManager = new NotificationManager(dashConfig.notifications);
    const storage = usagePollStorage();

    await storage.ensureDirs();
    await notifManager.loadState(storage);
    endSetup();

    try {
        // `force: true` — the daemon is the every-minute driver, so every other consumer
        // reads its cache for free. Per-provider floors (`usage.minIntervalMs`) still
        // apply inside the shared cache, which is why codex and grok are not refetched on
        // every tick even under force.
        // The walk reads none of this round's snapshots, so it runs beside the poll and the tick lasts as long as the
        // slower of the two, not their sum (poll p90 21 s, walk p90 24 s, one after the other on 2026-10-12).
        const rows = refreshSessionRows();
        const snapshots = await prof.measureAsync("tick.poll-accounts", () => pollAccounts({ force: true }), cpuMeta());

        if (snapshots.length === 0) {
            logger.warn("[ai-usage] daemon poll found no configured accounts");
            out.error(`No accounts configured. Run: ${toolCommand("claude login")}`);
            process.exit(1);
        }

        // Tells every reader the daemon is refreshing the cache, so they stop refetching themselves.
        touchUsageDaemonHeartbeat();

        const endNotify = prof.start("tick.notifications", cpuMeta());
        for (const window of notifiableWindows(snapshots)) {
            try {
                await notifManager.processUsage(window);
            } catch (err) {
                logger.warn({ err, account: window.accountName, key: window.key }, "[ai-usage] notification failed");
            }
        }
        endNotify();

        notifManager.markFirstPollDone();

        try {
            await notifManager.saveState(storage);
        } catch (err) {
            logger.warn({ err }, "[ai-usage] notification state save failed");
        }

        const anthropic = anthropicRows(snapshots);

        // Extra-usage (the paid overflow credit) has its own tracker and its own message,
        // and it is anthropic-only: no other provider reports a spend cap on the usage
        // endpoint. It runs here rather than inside the poll core so `src/utils` keeps no
        // dependency on the claude config.
        try {
            await prof.measureAsync(
                "tick.extra-usage",
                () => processExtraUsageNotifications(anthropic.filter((row) => !row.stale)),
                cpuMeta()
            );
        } catch (err) {
            logger.warn({ err }, "[ai-usage] extra-usage notification pass failed");
        }

        try {
            await prof.measureAsync(
                "tick.warmups",
                async () => {
                    const { processWarmupRules } = await import("@app/claude/lib/warmup/service");
                    await processWarmupRules(anthropic.filter((row) => !row.stale));
                },
                cpuMeta()
            );
        } catch (err) {
            out.warn(`Warmup check failed: ${err}`);
        }

        prof.measure("tick.prune", () => db.pruneOlderThan(dashConfig.dataRetentionDays));
        await rows;

        const errorCount = snapshots.filter((s) => s.error).length;
        logger.info(
            { accounts: snapshots.length, errorCount, duration_ms: Date.now() - startedAt },
            "[ai-usage] daemon poll completed"
        );
        out.println(`Polled ${snapshots.length} account(s)${errorCount > 0 ? ` (${errorCount} error(s))` : ""}`);

        for (const snapshot of snapshots) {
            const status = snapshot.error ?? snapshot.stale?.reason ?? "ok";
            out.println(`  ${snapshot.provider}/${snapshot.accountName}: ${status}${snapshot.stale ? " [stale]" : ""}`);
        }
    } finally {
        db.close();
    }
}

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

/**
 * The Codex poll runs its account in a throwaway `CODEX_HOME` and removes it in a `finally`.
 * That `finally` never runs when the round is killed, and killing it is routine: the daemon
 * runner SIGTERMs this task's whole process tree once a round passes its 60s budget, which a
 * laptop waking mid-poll reaches every time. Ten homes had collected by 2026-09-11.
 *
 * Only homes THIS process owns are released. A `tools ai usage` or `tools codex usage` in
 * another terminal keeps its own home in the same directory and must not lose it.
 */
function releaseTempHomesOnSignal(): void {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => {
            const exit = () => process.exit(SIGNAL_EXIT_CODES[signal]);
            // Bounded, because installing a handler suppresses the default termination and
            // the runner follows SIGTERM with SIGKILL: a cleanup that hangs would trade a
            // leaked directory for a leaked process. The bound is the runner's own budget, so
            // its SIGKILL cannot land before this cleanup has had its full time.
            const deadline = setTimeout(exit, TASK_SIGTERM_CLEANUP_MS);

            deadline.unref();
            void releaseCodexUsageHomes()
                .catch((err: unknown) => logger.warn({ err, signal }, "[ai-usage] temp home release failed"))
                .then(exit);
        });
    }
}

if (import.meta.main) {
    releaseTempHomesOnSignal();
    // One `[profile:cli]` line per tick (CPU, memory, wall): the tick runs every minute in a new process.
    recordRunOnExit("ai usage poll-daemon");

    try {
        await main();
        process.exit(0);
    } catch (err) {
        logger.error({ error: err }, "[ai-usage] daemon poll failed");
        out.error(err);
        process.exit(1);
    }
}
