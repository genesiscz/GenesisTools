import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { workerTurnLogPath } from "@app/claude/lib/worker/paths";
import { ClaudeWorkerStore } from "@app/claude/lib/worker/store";
import { sessionEventsPath } from "@app/codex/lib/paths";
import { CodexSessionStore } from "@app/codex/lib/store";
import { turnLogPath } from "@app/grok/lib/paths";
import { GrokSessionStore } from "@app/grok/lib/store";
import { claudeTurnUsage, parseTurnEvents as parseClaudeTurnEvents } from "@genesiscz/utils/claude/worker-stream";
import { CodexTurnCostTracker, codexCallTokens } from "@genesiscz/utils/codex/turn-cost";
import { grokTurnUsage, parseTurnLog } from "@genesiscz/utils/grok/stream";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isToolCall } from "@genesiscz/utils/worker/events";
import { buildWorkerCostRow, type WorkerCostRow, workerCostRowKey } from "./ledger";
import { loadWorkerSessionEvents } from "./stats";

const log = logger.child({ component: "ai-spend:worker-backfill" });

/**
 * One-off: book ledger rows for worker turns that ran before the ledger existed.
 *
 * READ-ONLY on every source file: codex's event log, grok's and claude's turn transcripts and
 * the session records. Each turn goes through the SAME extraction and pricing the live turn
 * path uses, and is marked `backfilled`. A key the ledger already holds is skipped, so running
 * it twice books nothing twice.
 */

export interface WorkerBackfillPlan {
    rows: WorkerCostRow[];
    /** Turns the ledger already holds. */
    skipped: number;
    notes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The turn's file times: birth is when the turn started, the last write when it ended. */
function fileSpan(path: string): { startedAt: Date; endedAt: Date } {
    const stat = statSync(path);
    return { startedAt: stat.birthtime, endedAt: stat.mtime };
}

function codexRows(): { rows: WorkerCostRow[]; notes: string[] } {
    const store = new CodexSessionStore();
    const rows: WorkerCostRow[] = [];
    const notes: string[] = [];

    for (const name of store.listNames()) {
        const meta = store.readMeta(name);

        if (!meta) {
            continue;
        }

        const base = {
            backend: "codex" as const,
            name,
            sessionId: meta.threadId ?? null,
            effort: meta.effort ?? null,
            account: meta.accountName ?? null,
            cwd: meta.cwd,
            ...(meta.label ? { label: meta.label } : {}),
            backfilled: true,
        };
        const eventsPath = sessionEventsPath(name);

        // Codex before 0.1x named no model in its notifications; the rollout's `turn_context` does.
        let rolloutModel: string | null | undefined;
        const modelOf = (named: string | null): string | null => {
            if (named) {
                return named;
            }

            rolloutModel ??=
                loadWorkerSessionEvents(
                    { backend: "codex", sessionId: meta.threadId ?? null, home: meta.home ?? null },
                    { home: homedir(), minMtimeMs: 0 }
                )?.find((event) => event.model)?.model ?? null;
            return rolloutModel;
        };

        if (existsSync(eventsPath)) {
            const tracker = new CodexTurnCostTracker({
                model: meta.model ?? null,
                auth: meta.accountName ? "subscription" : "unknown",
            });

            for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
                if (!line.trim()) {
                    continue;
                }

                let record: unknown;
                try {
                    record = SafeJSON.parse(line, { strict: true });
                } catch (err) {
                    log.debug({ err, name }, "codex backfill: unreadable event line");
                    continue;
                }

                if (!isRecord(record) || record.source !== "app-server" || typeof record.method !== "string") {
                    continue;
                }

                // A native subagent's thread is not this worker's (the live runtime skips it the same way).
                const threadId = isRecord(record.params) ? record.params.threadId : undefined;

                if (typeof threadId === "string" && meta.threadId && threadId !== meta.threadId) {
                    continue;
                }

                const at = typeof record.ts === "string" ? new Date(record.ts) : new Date(meta.lastEventAt);
                const finished = tracker.observe({ method: record.method, params: record.params }, at);

                if (finished) {
                    rows.push(
                        buildWorkerCostRow({
                            ...base,
                            turn: finished.turn,
                            model: modelOf(finished.model ?? meta.model ?? null),
                            auth: finished.auth,
                            startedAt: finished.startedAt,
                            endedAt: finished.endedAt,
                            durationMs: finished.durationMs,
                            toolCalls: finished.toolCalls,
                            parts: finished.parts,
                            outcome: finished.outcome,
                        })
                    );
                }
            }

            continue;
        }

        if (meta.usage && Object.keys(meta.usage).length > 0) {
            // No event log: the session total is all there is, booked as one row with no turn.
            notes.push(`codex ${name}: no event log, booked the session total as one row`);
            rows.push(
                buildWorkerCostRow({
                    ...base,
                    turn: null,
                    model: modelOf(meta.model ?? null),
                    auth: meta.accountName ? "subscription" : "unknown",
                    startedAt: new Date(meta.startedAt),
                    endedAt: new Date(meta.lastEventAt),
                    toolCalls: null,
                    parts: [{ model: meta.model ?? null, tokens: codexCallTokens(meta.usage) }],
                })
            );
        }
    }

    return { rows, notes };
}

function grokRows(): WorkerCostRow[] {
    const store = new GrokSessionStore();
    const rows: WorkerCostRow[] = [];

    for (const name of store.listNames()) {
        const meta = store.readMeta(name);

        if (!meta) {
            continue;
        }

        for (let turn = 1; turn <= meta.turns; turn++) {
            const path = turnLogPath(name, turn);

            if (!existsSync(path)) {
                continue;
            }

            const text = readFileSync(path, "utf8");
            const summary = parseTurnLog(text);
            const usage = grokTurnUsage(text);
            const span = fileSpan(path);
            const endedAt = meta.lastTurn?.turn === turn ? new Date(meta.lastTurn.at) : span.endedAt;

            rows.push(
                buildWorkerCostRow({
                    backend: "grok",
                    name,
                    sessionId: meta.sessionId,
                    turn,
                    model: usage.model ?? meta.model ?? null,
                    auth: meta.auth ?? "unknown",
                    startedAt: span.startedAt,
                    endedAt,
                    toolCalls: summary.toolCalls.length,
                    parts: usage.parts,
                    reportedUsd: usage.reportedUsd,
                    cwd: meta.cwd,
                    ...(meta.label ? { label: meta.label } : {}),
                    outcome: summary.ended ? "completed" : "failed",
                    backfilled: true,
                })
            );
        }
    }

    return rows;
}

function claudeRows(): WorkerCostRow[] {
    const store = new ClaudeWorkerStore();
    const rows: WorkerCostRow[] = [];

    for (const name of store.listNames()) {
        const meta = store.readMeta(name);

        if (!meta) {
            continue;
        }

        for (let turn = 1; turn <= meta.turns; turn++) {
            const path = workerTurnLogPath(name, turn);

            if (!existsSync(path)) {
                continue;
            }

            const text = readFileSync(path, "utf8");
            const events = parseClaudeTurnEvents(text, meta.sessionId);
            const usage = claudeTurnUsage(text);
            const span = fileSpan(path);
            const endedAt = meta.lastTurn?.turn === turn ? new Date(meta.lastTurn.at) : span.endedAt;

            rows.push(
                buildWorkerCostRow({
                    backend: "claude",
                    name,
                    sessionId: meta.sessionId,
                    turn,
                    model: usage.model ?? meta.model ?? null,
                    auth: "subscription",
                    account: meta.account,
                    startedAt: span.startedAt,
                    endedAt,
                    toolCalls: events.filter(isToolCall).length,
                    parts: usage.parts,
                    reportedUsd: usage.reportedUsd,
                    cwd: meta.cwd,
                    ...(meta.label ? { label: meta.label } : {}),
                    outcome: events.some((event) => event.kind === "turn.completed") ? "completed" : "failed",
                    backfilled: true,
                })
            );
        }
    }

    return rows;
}

function sourceRows(): { rows: WorkerCostRow[]; notes: string[] } {
    const codex = codexRows();
    return { rows: [...codex.rows, ...grokRows(), ...claudeRows()], notes: codex.notes };
}

/** Every past turn not yet in the ledger, oldest first. Writes nothing. */
export function planWorkerBackfill(existing: readonly WorkerCostRow[]): WorkerBackfillPlan {
    const have = new Set(existing.map(workerCostRowKey));
    const all = sourceRows();
    const rows = all.rows.filter((row) => !have.has(workerCostRowKey(row))).sort((a, b) => a.ts.localeCompare(b.ts));

    return { rows, skipped: all.rows.length - rows.length, notes: all.notes };
}

export interface WorkerRepricePlan {
    /** The whole ledger after re-pricing, in its original order. */
    rows: WorkerCostRow[];
    /** Rows whose turn files still exist, priced again under today's rules. */
    repriced: Array<{ before: WorkerCostRow; after: WorkerCostRow }>;
    /** Rows whose turn files are gone: they keep the price they were booked at. */
    kept: number;
}

/**
 * Every ledger row priced again from its turn's own files, through the same extraction and
 * pricing as a live turn. Only the price moves (card, tokens, pricing version): the name, label,
 * login, duration and the `backfilled` mark stay as they were booked. Writes nothing.
 */
export function planWorkerReprice(
    existing: readonly WorkerCostRow[],
    sources: readonly WorkerCostRow[] = sourceRows().rows
): WorkerRepricePlan {
    const fresh = new Map(sources.map((row) => [workerCostRowKey(row), row]));
    const repriced: WorkerRepricePlan["repriced"] = [];
    let kept = 0;
    const rows = existing.map((row) => {
        const now = fresh.get(workerCostRowKey(row));

        if (!now) {
            kept += 1;
            return row;
        }

        const after: WorkerCostRow = {
            ...row,
            priced: now.priced,
            model: row.model ?? now.model,
            tokens: now.tokens,
            cost: { ...now.cost, auth: row.cost.auth, billedUsd: billedFor(row.auth, now.cost.apiEquivalentUsd) },
        };
        repriced.push({ before: row, after });
        return after;
    });

    return { rows, repriced, kept };
}

/** What a login billed for a list price: the login is the booked row's, never re-derived. */
function billedFor(auth: WorkerCostRow["auth"], apiEquivalentUsd: number | null): number | null {
    return auth === "subscription" ? 0 : auth === "api-key" ? apiEquivalentUsd : null;
}
