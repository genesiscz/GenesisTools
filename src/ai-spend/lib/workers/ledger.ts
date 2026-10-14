import { createHash } from "node:crypto";
import {
    appendFileSync,
    closeSync,
    copyFileSync,
    existsSync,
    fstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
} from "node:fs";
import { dirname } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { assertTestSafePath } from "@genesiscz/utils/storage/real-home-guard";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import type { WorkerBackend } from "@genesiscz/utils/worker/capabilities";
import {
    addTokens,
    EMPTY_TOKENS,
    sumPartTokens,
    type WorkerAuthMode,
    type WorkerTokens,
    type WorkerUsagePart,
} from "@genesiscz/utils/worker/cost";
import { z } from "zod";
import { DEFAULT_PRICING } from "../pricing";
import type { PricingTable } from "../types";
import { formatCostLine, type WorkerCostCard, workerCostCard } from "./cost";

const log = logger.child({ component: "ai-spend:worker-ledger" });

/**
 * One row per finished worker turn, in `~/.genesis-tools/workers/cost-ledger.jsonl`.
 *
 * It holds what no transcript records: the worker's name and label, the login it billed, the
 * turn number, its duration and tool calls. The card is ai-spend's price of the turn's own
 * usage at the moment it ended, booked once (a later price edit never rewrites it). The stats
 * read token and cost numbers from ai-spend's transcripts and use these rows for the rest.
 *
 * Appends and rewrites share a cross-process lock. Rewrites also validate the original
 * snapshot before replacing it, so a concurrent repricer cannot silently overwrite new prices.
 */

/**
 * The pricing rules a row's card was computed under. 2 (2026-10-14): grok bills its list price
 * instead of the CLI's own metering, xAI list rates are in the catalog, and Claude's one-hour
 * cache writes bill at 2x input. A row under an older number shows as stale until
 * `tools ai-spend workers --reprice` recomputes it from its turn's files.
 */
export const WORKER_PRICING_VERSION = 2;

export interface WorkerCostRow {
    v: 1;
    /** `WORKER_PRICING_VERSION` the card was computed under; absent on the first rows (version 1). */
    priced?: number;
    /** When the turn ended. */
    ts: string;
    backend: WorkerBackend;
    name: string;
    /** The backend's conversation id (codex thread, grok/claude session uuid): a reused name is another session. */
    sessionId: string | null;
    /** null: a whole session booked as one row (a backfilled codex session with no event log). */
    turn: number | null;
    model: string | null;
    effort: string | null;
    auth: WorkerAuthMode;
    /** The account NAME the turn ran under; never a credential. */
    account: string | null;
    durationMs: number | null;
    toolCalls: number | null;
    /** Summed over every model call of the turn; null when the turn reported no usage. */
    tokens: WorkerTokens | null;
    cost: WorkerCostCard;
    cwd: string;
    label?: string;
    outcome?: "completed" | "failed" | "interrupted";
    /** Written by the one-off backfill from past session files, not when the turn ran. */
    backfilled?: true;
}

export interface WorkerTurnCostInput {
    backend: WorkerBackend;
    name: string;
    sessionId?: string | null;
    turn: number | null;
    /** The session's model: fills any usage part that did not name its own. */
    model?: string | null;
    effort?: string | null;
    auth: WorkerAuthMode;
    account?: string | null;
    startedAt?: Date | null;
    endedAt: Date;
    /** Overrides `endedAt - startedAt` when the backend measured the turn itself. */
    durationMs?: number | null;
    toolCalls: number | null;
    parts: readonly WorkerUsagePart[] | null;
    reportedUsd?: number | null;
    cwd: string;
    label?: string;
    outcome?: WorkerCostRow["outcome"];
    backfilled?: boolean;
}

export function workerCostLedgerPath(): string {
    return genesisToolsDir("workers", "cost-ledger.jsonl");
}

function withSessionModel(input: WorkerTurnCostInput): WorkerUsagePart[] | null {
    if (input.parts === null) {
        return null;
    }

    return input.parts.map((part) => (part.model === null && input.model ? { ...part, model: input.model } : part));
}

/** Pure: the row a finished turn books. */
export function buildWorkerCostRow(input: WorkerTurnCostInput, pricing: PricingTable = DEFAULT_PRICING): WorkerCostRow {
    const parts = withSessionModel(input);
    const measured = input.startedAt != null ? Math.max(0, input.endedAt.getTime() - input.startedAt.getTime()) : null;
    const label = input.label?.trim();
    const card = workerCostCard(
        {
            backend: input.backend,
            sessionId: input.sessionId ?? input.name,
            parts,
            auth: input.auth,
            reportedUsd: input.reportedUsd,
            at: input.endedAt,
        },
        pricing
    );

    return {
        v: 1,
        priced: WORKER_PRICING_VERSION,
        ts: input.endedAt.toISOString(),
        backend: input.backend,
        name: input.name,
        sessionId: input.sessionId ?? null,
        turn: input.turn,
        model: input.model ?? parts?.find((part) => part.model)?.model ?? null,
        effort: input.effort ?? null,
        auth: input.auth,
        account: input.account ?? null,
        durationMs: input.durationMs ?? measured,
        toolCalls: input.toolCalls,
        tokens: parts === null ? null : sumPartTokens(parts),
        cost: card,
        cwd: input.cwd,
        ...(label ? { label } : {}),
        ...(input.outcome ? { outcome: input.outcome } : {}),
        ...(input.backfilled ? { backfilled: true as const } : {}),
    };
}

/** Append one row. Throws on failure; the turn path goes through `recordWorkerTurnCost`, which never does. */
export async function appendWorkerCostRows(rows: readonly WorkerCostRow[]): Promise<WorkerCostRow[]> {
    if (rows.length === 0) {
        return [];
    }

    const path = workerCostLedgerPath();
    assertTestSafePath(path, "append a worker cost row");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    return withFileLock(path + ".lock", async () => {
        const keys = new Set(readWorkerCostRows().map(workerCostRowKey));
        const fresh = rows.filter((row) => {
            const key = workerCostRowKey(row);
            if (keys.has(key)) {
                return false;
            }
            keys.add(key);
            return true;
        });
        const text = fresh.map((row) => SafeJSON.stringify(row, { strict: true }) + "\n").join("");
        if (text) {
            appendFileSync(path, text, { mode: 0o600, flag: "a" });
        }
        return fresh;
    });
}

export function isStalePrice(row: WorkerCostRow): boolean {
    return (row.priced ?? 1) < WORKER_PRICING_VERSION;
}

/** A booked row's cost line, saying so when its price predates today's rules. */
export function bookedCostLine(row: WorkerCostRow): string {
    const line = formatCostLine(row.cost, row.backend);
    return isStalePrice(row)
        ? `${line} · priced under older rules, see: ${toolCommand("ai-spend workers")} --reprice`
        : line;
}

/**
 * Replace the whole ledger with `rows`, through an atomic rename, after copying the old ledger to
 * `.bak`. A row a live worker appended while the new copy was being built is carried over: the
 * bytes past the length this rewrite started from are appended to the new copy before the rename.
 * The copy is made here rather than through the atomic writer's own backup option, so this file
 * works on every branch the writer is on.
 */
export async function rewriteWorkerCostRows(
    rows: readonly WorkerCostRow[],
    snapshot: { bytes: number; hash: string }
): Promise<void> {
    const path = workerCostLedgerPath();
    const text = rows.map((row) => `${SafeJSON.stringify(row, { strict: true })}\n`).join("");
    assertTestSafePath(path, "rewrite the worker cost ledger");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    await withFileLock(path + ".lock", async () => {
        const current = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
        if (
            current.length < snapshot.bytes ||
            createHash("sha256").update(current.subarray(0, snapshot.bytes)).digest("hex") !== snapshot.hash
        ) {
            throw new Error("Worker cost ledger changed since the reprice began; read it again and retry");
        }
        const lateAppends = current.subarray(snapshot.bytes).toString("utf8");

        if (existsSync(path)) {
            copyFileSync(path, `${path}.bak`);
        }

        atomicWriteFileSync(path, text + lateAppends, { mode: 0o600 });
    });
}

/**
 * Price a finished turn and book it. NEVER throws: the price is an in-process catalog read,
 * and a failure is logged while the turn report simply goes without its cost line.
 */
export async function recordWorkerTurnCost(input: WorkerTurnCostInput): Promise<WorkerCostRow | null> {
    try {
        const row = buildWorkerCostRow(input);
        const appended = await appendWorkerCostRows([row]);
        const booked =
            appended[0] ?? readWorkerCostRows().findLast((saved) => workerCostRowKey(saved) === workerCostRowKey(row));
        if (!booked) {
            throw new Error("Deduplicated worker turn cost is missing from the ledger");
        }

        log.debug(
            {
                backend: booked.backend,
                name: booked.name,
                turn: booked.turn,
                line: formatCostLine(booked.cost, booked.backend),
            },
            appended.length > 0 ? "worker turn cost booked" : "worker turn cost already booked"
        );
        return booked;
    } catch (err) {
        log.warn({ err, backend: input.backend, name: input.name, turn: input.turn }, "worker cost: booking failed");
        return null;
    }
}

const amount = z.number().finite().nonnegative();
const authMode = z.enum(["subscription", "api-key", "unknown"]);
const tokensSchema = z.object({
    input: amount,
    cacheRead: amount,
    cacheWrite: amount,
    cacheWrite1h: amount.optional(),
    output: amount,
    reasoning: amount,
});
const rowSchema = z.object({
    v: z.literal(1),
    priced: amount.optional(),
    ts: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    backend: z.enum(["codex", "grok", "claude"]),
    name: z.string().min(1),
    sessionId: z.string().nullable(),
    turn: amount.int().nullable(),
    model: z.string().nullable(),
    effort: z.string().nullable(),
    auth: authMode,
    account: z.string().nullable(),
    durationMs: amount.nullable(),
    toolCalls: amount.int().nullable(),
    tokens: tokensSchema.nullable(),
    cwd: z.string(),
    label: z.string().optional(),
    outcome: z.enum(["completed", "failed", "interrupted"]).optional(),
    backfilled: z.literal(true).optional(),
    cost: z.object({
        apiEquivalentUsd: amount.nullable(),
        billedUsd: amount.nullable(),
        auth: authMode,
        basis: z.enum(["recorded", "catalog", "reported", "unpriced"]),
        pricedAs: z.array(z.string()),
        unpriced: z.string().optional(),
        longContextRequests: amount.int(),
        reportedUsd: amount.optional(),
        claudeEquivalent: z.object({
            estimate: z.literal(true),
            opusModel: z.string(),
            sonnetModel: z.string(),
            opusUsd: amount.nullable(),
            sonnetUsd: amount.nullable(),
        }),
    }),
});

function isRow(value: unknown): value is WorkerCostRow {
    return rowSchema.safeParse(value).success;
}

/** Every row, in the order written. Malformed lines are skipped and counted in the log. */
export function readWorkerCostRows(): WorkerCostRow[] {
    return scanWorkerCostLedger().rows;
}

/** The rows and the byte length they were read at, for a rewrite that must not lose a late append. */
export function readWorkerCostLedger(): { rows: WorkerCostRow[]; bytes: number; hash: string } {
    return scanWorkerCostLedger({ snapshot: true });
}

const LEDGER_CHUNK_BYTES = 64 * 1024;
const STATUS_LEDGER_BYTES = 1024 * 1024;
const MAX_LEDGER_LINE_BYTES = 1024 * 1024;

/** Read a stable file size in fixed-size chunks; status uses a bounded tail and never computes a lifetime hash. */
function scanWorkerCostLedger({ maxBytes, snapshot = false }: { maxBytes?: number; snapshot?: boolean } = {}): {
    rows: WorkerCostRow[];
    bytes: number;
    hash: string;
    partial: boolean;
} {
    const path = workerCostLedgerPath();
    const hash = createHash("sha256");
    if (!existsSync(path)) {
        return { rows: [], bytes: 0, hash: hash.digest("hex"), partial: false };
    }

    const fd = openSync(path, "r");
    try {
        const size = fstatSync(fd).size;
        const start = maxBytes === undefined ? 0 : Math.max(0, size - maxBytes);
        let offset = start;
        let pending = Buffer.alloc(0);
        let dropping = start > 0;
        let malformed = 0;
        const rows: WorkerCostRow[] = [];
        const chunk = Buffer.alloc(LEDGER_CHUNK_BYTES);
        const accept = (line: Buffer) => {
            if (!line.toString("utf8").trim()) {
                return;
            }
            try {
                const parsed: unknown = SafeJSON.parse(line.toString("utf8"), { strict: true });
                if (isRow(parsed)) {
                    rows.push(parsed);
                } else {
                    malformed += 1;
                }
            } catch (error) {
                malformed += 1;
                log.debug({ error }, "worker cost ledger: unreadable line");
            }
        };

        while (offset < size) {
            const count = readSync(fd, chunk, {
                offset: 0,
                length: Math.min(chunk.length, size - offset),
                position: offset,
            });
            if (count === 0) {
                break;
            }
            offset += count;
            const bytes = chunk.subarray(0, count);
            if (snapshot) {
                hash.update(bytes);
            }
            let from = 0;
            for (let newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10, from)) {
                const segment = bytes.subarray(from, newline);
                if (!dropping && pending.length + segment.length <= MAX_LEDGER_LINE_BYTES) {
                    accept(Buffer.concat([pending, segment]));
                } else if (!dropping) {
                    malformed += 1;
                }
                pending = Buffer.alloc(0);
                dropping = false;
                from = newline + 1;
            }
            if (!dropping) {
                const tail = bytes.subarray(from);
                if (pending.length + tail.length > MAX_LEDGER_LINE_BYTES) {
                    malformed += 1;
                    pending = Buffer.alloc(0);
                    dropping = true;
                } else {
                    pending = Buffer.concat([pending, tail]);
                }
            }
        }
        if (!dropping && pending.length > 0) {
            accept(pending);
        }
        if (malformed > 0) {
            log.warn({ path, malformed }, "worker cost ledger: skipped malformed lines");
        }
        return { rows, bytes: offset, hash: hash.digest("hex"), partial: start > 0 };
    } finally {
        closeSync(fd);
    }
}

/** The identity a row books under; backfill skips a key the ledger already holds. */
export function workerCostRowKey(row: Pick<WorkerCostRow, "backend" | "name" | "sessionId" | "turn">): string {
    return `${row.backend}|${row.sessionId ?? row.name}|${row.turn ?? "session"}`;
}

/** Ledger totals of some rows: what `status --json` shows for a session. */
export interface WorkerLedgerTotals {
    turns: number;
    tokens: WorkerTokens;
    durationMs: number;
    toolCalls: number;
    apiEquivalentUsd: number;
    /** Turns whose API-equivalent is unknown: not in the sum. */
    unpricedTurns: number;
    billedUsd: number;
    claudeOpusUsd: number;
    claudeSonnetUsd: number;
}

export function ledgerTotals(rows: readonly WorkerCostRow[]): WorkerLedgerTotals {
    const totals: WorkerLedgerTotals = {
        turns: 0,
        tokens: EMPTY_TOKENS,
        durationMs: 0,
        toolCalls: 0,
        apiEquivalentUsd: 0,
        unpricedTurns: 0,
        billedUsd: 0,
        claudeOpusUsd: 0,
        claudeSonnetUsd: 0,
    };

    for (const row of rows) {
        totals.turns += 1;
        totals.tokens = addTokens(totals.tokens, row.tokens ?? EMPTY_TOKENS);
        totals.durationMs += row.durationMs ?? 0;
        totals.toolCalls += row.toolCalls ?? 0;
        totals.billedUsd += row.cost.billedUsd ?? 0;
        totals.claudeOpusUsd += row.cost.claudeEquivalent.opusUsd ?? 0;
        totals.claudeSonnetUsd += row.cost.claudeEquivalent.sonnetUsd ?? 0;

        if (row.cost.apiEquivalentUsd === null) {
            totals.unpricedTurns += 1;
        } else {
            totals.apiEquivalentUsd += row.cost.apiEquivalentUsd;
        }
    }

    return totals;
}

/** What `status --json` shows for one session: its last turn's card and the session's ledger totals. */
export function sessionCostSummary(options: {
    backend: WorkerBackend;
    name: string;
    sessionId?: string | null;
}): { lastTurn: WorkerCostRow & { line: string }; session: WorkerLedgerTotals; note: string } | null {
    const scanned = scanWorkerCostLedger({ maxBytes: STATUS_LEDGER_BYTES });
    const rows = scanned.rows.filter(
        (row) =>
            row.backend === options.backend &&
            row.name === options.name &&
            (!options.sessionId || !row.sessionId || row.sessionId === options.sessionId)
    );
    const last = rows.at(-1);

    if (!last) {
        return null;
    }

    return {
        lastTurn: { ...last, line: bookedCostLine(last) },
        session: ledgerTotals(rows),
        note:
            (scanned.partial
                ? "Partial session totals: only the most recent 1 MiB of the ledger was scanned. Use ai-spend workers for complete history. "
                : "") +
            "Priced by ai-spend: API-equivalent is the worker model's list price per request; a figure the worker reported itself stands in only for a model without a list price. The Claude figures are estimates, since tokenizers and agent behaviour differ.",
    };
}

/** The card a past turn booked, for a replayed turn report. */
export function bookedTurnCost(options: {
    backend: WorkerBackend;
    name: string;
    sessionId?: string | null;
    turn: number;
}): WorkerCostRow | null {
    return (
        readWorkerCostRows().findLast(
            (row) =>
                row.backend === options.backend &&
                row.name === options.name &&
                row.turn === options.turn &&
                (!options.sessionId || !row.sessionId || row.sessionId === options.sessionId)
        ) ?? null
    );
}
