import { existsSync } from "node:fs";
import { readWorkerCostRows, type WorkerCostRow } from "@app/ai-spend/lib/workers/ledger";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { isReviewEffort, manifestChangedLines, type ReviewManifest } from "@genesiscz/utils/worker/contract";
import { type CodexSessionMeta, CodexSessionStore } from "../store";
import { parseReviewReport, REASONING_FLOOR_PER_100_LINES, reasoningPer100Lines } from "./gate";
import {
    appendReviewRecord,
    type ReviewLedgerBase,
    type ReviewLedgerRecord,
    readReviewRecords,
    reviewLedgerPath,
} from "./ledger";
import { buildManifest, type ChosenBase, chooseBase, defaultReviewGitReaders, type ReviewGitReaders } from "./prepare";
import type { CodexReviewSpent, ReviewVerdict } from "./types";

const log = logger.child({ component: "codex:review-import" });

/** The last agent message of the session's own thread, from its event log; "" when it has none. */
export async function lastAgentMessage(store: CodexSessionStore, meta: CodexSessionMeta): Promise<string> {
    const events = await store.readEvents(meta.name);

    for (const event of events.toReversed()) {
        const params = event.params;

        if (event.method !== "item/completed" || !isObject(params) || !isObject(params.item)) {
            continue;
        }

        const { item, threadId } = params;

        if (
            item.type === "agentMessage" &&
            typeof item.text === "string" &&
            (threadId === undefined || threadId === meta.threadId)
        ) {
            return item.text;
        }
    }

    return "";
}

/** Everything an import reads; injected so tests need no codex, no git and no network. */
export interface ReviewImportReaders {
    readMeta(name: string): Promise<CodexSessionMeta | null>;
    /** The session's booked turns from the worker cost ledger, oldest first. */
    costRows(meta: CodexSessionMeta): WorkerCostRow[];
    lastAgentMessage(meta: CodexSessionMeta): Promise<string>;
    cwdExists(path: string): boolean;
    git: ReviewGitReaders;
    /** The review ledger as it is now, for the already-imported check. */
    ledgerRecords(): ReviewLedgerRecord[];
}

export function defaultReviewImportReaders(ledgerPath = reviewLedgerPath()): ReviewImportReaders {
    const store = new CodexSessionStore();

    return {
        readMeta: async (name) => store.readMeta(name),
        costRows: (meta) =>
            readWorkerCostRows()
                .filter(
                    (row) =>
                        row.backend === "codex" &&
                        row.name === meta.name &&
                        (!meta.threadId || !row.sessionId || row.sessionId === meta.threadId)
                )
                .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)),
        lastAgentMessage: (meta) => lastAgentMessage(store, meta),
        cwdExists: (path) => existsSync(path),
        git: defaultReviewGitReaders(),
        ledgerRecords: () => readReviewRecords(ledgerPath).records,
    };
}

export interface ReviewImportManifest {
    base: string;
    /** The commit the manifest ends at: the last one before the session started, else HEAD. */
    head: string;
    files: number;
    lines: number;
}

export interface ReviewImportResult {
    name: string;
    status: "imported" | "skipped" | "missing";
    verdict?: ReviewVerdict;
    manifest: ReviewImportManifest | null;
    /** Why something is missing or approximate, in one sentence per fact. */
    notes: string[];
}

export interface ReviewImportInput {
    names: string[];
    /** One base for every named session; without it the PR target or upstream of each session's branch. */
    base?: string;
    /** Read the manifest in the session's own cwd (default). False leaves every manifest null. */
    cwdFromSession?: boolean;
    readers?: ReviewImportReaders;
    ledgerPath?: string;
}

interface ManifestOutcome {
    manifest: ReviewManifest | null;
    chosen: ChosenBase | null;
    branch: string | null;
    head: string | null;
    notes: string[];
}

async function importManifest(meta: CodexSessionMeta, input: ReviewImportInput, git: ReviewGitReaders) {
    const none = (note: string): ManifestOutcome => ({
        manifest: null,
        chosen: null,
        branch: null,
        head: null,
        notes: [note],
    });

    if (input.cwdFromSession === false) {
        return none("manifest skipped (--no-cwd-from-session): file and line counts are null");
    }

    const cwd = meta.cwd;
    const branch = await git.currentBranch(cwd);
    let chosen: ChosenBase;

    try {
        chosen = await chooseBase({ cwd, ...(input.base ? { base: input.base } : {}), readers: git, branch });
    } catch (err) {
        return none(`no base: ${err instanceof Error ? err.message : String(err)} File and line counts are null.`);
    }

    // The worktree may have gained fix commits since the review: diff up to the commit the review saw.
    const seen = await git.commitBefore(cwd, meta.startedAt);
    const notes = seen
        ? [
              `manifest ${chosen.ref}...${seen.slice(0, 10)} (the last commit before the session started at ${meta.startedAt})`,
          ]
        : [`no commit before ${meta.startedAt}; the manifest runs to HEAD and may include later commits`];
    const head = seen ?? "HEAD";
    const manifest = buildManifest(chosen.ref, await git.numstat(cwd, chosen.ref, undefined, head));
    return { manifest, chosen, branch, head, notes } satisfies ManifestOutcome;
}

function spentOf(rows: readonly WorkerCostRow[]): CodexReviewSpent {
    return {
        turns: rows.length,
        durationMs: rows.reduce((sum, row) => sum + (row.durationMs ?? 0), 0),
        toolCalls: rows.reduce((sum, row) => sum + (row.toolCalls ?? 0), 0),
        reasoningTokens: rows.reduce((sum, row) => sum + (row.tokens?.reasoning ?? 0), 0),
        outputTokens: rows.reduce((sum, row) => sum + (row.tokens?.output ?? 0), 0),
        costUsd: rows.some((row) => row.cost.apiEquivalentUsd === null)
            ? null
            : rows.reduce((sum, row) => sum + (row.cost.apiEquivalentUsd ?? 0), 0),
    };
}

/** The verdict the final message's coverage line implies: n of n passes, fewer is shallow, none is `imported`. */
function impliedVerdict(
    coverage: { reviewed: number; total: number } | null,
    manifest: ReviewManifest | null
): { verdict: ReviewVerdict; reason: string } {
    if (!coverage) {
        return {
            verdict: "imported",
            reason: "imported from a session that ran before the ledger; its final message has no Files reviewed line",
        };
    }

    const mismatch =
        manifest && coverage.total !== manifest.files.length
            ? `; the reviewed manifest has ${manifest.files.length} files`
            : "";

    if (coverage.reviewed >= coverage.total) {
        return {
            verdict: "pass",
            reason: `imported: Files reviewed ${coverage.reviewed} of ${coverage.total}${mismatch}`,
        };
    }

    return {
        verdict: "shallow",
        reason: `imported: Files reviewed ${coverage.reviewed} of ${coverage.total}, ${coverage.total - coverage.reviewed} unread${mismatch}`,
    };
}

async function importOne(name: string, input: ReviewImportInput, readers: ReviewImportReaders, ledgerPath: string) {
    const meta = await readers.readMeta(name);

    if (!meta) {
        return {
            name,
            status: "missing",
            manifest: null,
            notes: ["no codex session record with that name"],
        } satisfies ReviewImportResult;
    }

    if (readers.ledgerRecords().some((record) => record.name === name)) {
        return {
            name,
            status: "skipped",
            manifest: null,
            notes: ["already in the review ledger"],
        } satisfies ReviewImportResult;
    }

    const outcome = readers.cwdExists(meta.cwd)
        ? await importManifest(meta, input, readers.git)
        : {
              manifest: null,
              chosen: null,
              branch: null,
              head: null,
              notes: [`${meta.cwd} is gone: file and line counts are null`],
          };
    const { manifest, chosen } = outcome;
    const rows = readers.costRows(meta);
    const report = await readers.lastAgentMessage(meta);
    const parsed = parseReviewReport(report);
    const notes = [...outcome.notes];

    if (rows.length === 0) {
        notes.push("no booked turns in the worker cost ledger");
    }

    if (!report) {
        notes.push("no final agent message in the session's event log");
    }

    const effort = meta.effort ?? "default";
    const base: ReviewLedgerBase = {
        v: 1,
        ts: meta.startedAt,
        name,
        chain: name,
        ...(meta.label ? { label: meta.label } : {}),
        ...(chosen?.pr ? { pr: chosen.pr.number } : {}),
        ...(outcome.branch ? { branch: outcome.branch } : {}),
        base: chosen?.ref ?? input.base ?? null,
        files: manifest ? manifest.files.length : null,
        lines: manifest ? manifestChangedLines(manifest) : null,
        effort,
        imported: true,
        ...(outcome.head ? { head: outcome.head } : {}),
    };
    const at = (ts: string) => ({ ...base, ts });

    appendReviewRecord(
        base,
        { kind: "start", cwd: meta.cwd, effortSource: "imported", allowShallow: false },
        ledgerPath
    );

    rows.forEach((row, index) => {
        appendReviewRecord(
            at(row.ts),
            {
                kind: "turn",
                turn: row.turn ?? index + 1,
                outcome: row.outcome ?? "completed",
                model: row.model,
                durationMs: row.durationMs,
                toolCalls: row.toolCalls ?? 0,
                reasoningTokens: row.tokens?.reasoning ?? null,
                outputTokens: row.tokens?.output ?? null,
                costUsd: row.cost.apiEquivalentUsd,
                // Only the final message survives, so only the last turn carries a coverage line.
                coverage: index === rows.length - 1 ? parsed.coverage : null,
            },
            ledgerPath
        );
    });

    const spent = spentOf(rows);
    const { verdict, reason } = impliedVerdict(parsed.coverage, manifest);
    appendReviewRecord(
        at(rows.at(-1)?.ts ?? meta.lastEventAt),
        {
            kind: "gate",
            step: 0,
            verdict,
            reason,
            coverage: {
                reviewed: parsed.coverage?.reviewed ?? null,
                total: parsed.coverage?.total ?? manifest?.files.length ?? 0,
            },
            reasoningPer100Lines: manifest ? reasoningPer100Lines(spent.reasoningTokens, manifest) : null,
            floor: isReviewEffort(effort) ? REASONING_FLOOR_PER_100_LINES[effort] : 0,
            findings: parsed.findings.length,
            malformedFindings: parsed.findings.filter((finding) => !finding.ok).length,
            unread: parsed.notReviewed.map((entry) => entry.path).slice(0, 40),
            spent,
        },
        ledgerPath
    );
    log.debug({ name, verdict, files: base.files, base: base.base, head: base.head }, "review imported");

    return {
        name,
        status: "imported",
        verdict,
        manifest:
            manifest && chosen
                ? {
                      base: chosen.ref,
                      head: outcome.head ?? "HEAD",
                      files: manifest.files.length,
                      lines: manifestChangedLines(manifest),
                  }
                : null,
        notes,
    } satisfies ReviewImportResult;
}

/**
 * Backfills the review ledger from codex sessions that ran before it existed: one start line, one turn line per
 * booked turn, and one gate line whose verdict the final message's coverage line implies. A session already in the
 * ledger is skipped, so a second import of the same names adds nothing.
 */
export async function importReviewSessions(input: ReviewImportInput): Promise<ReviewImportResult[]> {
    const ledgerPath = input.ledgerPath ?? reviewLedgerPath();
    const readers = input.readers ?? defaultReviewImportReaders(ledgerPath);
    const results: ReviewImportResult[] = [];

    for (const name of [...new Set(input.names)]) {
        results.push(await importOne(name, input, readers, ledgerPath));
    }

    return results;
}
