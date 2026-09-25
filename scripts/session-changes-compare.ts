#!/usr/bin/env bun
/**
 * OLD vs NEW per-turn changed files, over real sessions on this machine.
 *
 * OLD is the change log as `tools agents changes --raw` reads it: every row the diff hook
 * recorded for a turn. NEW is `@genesiscz/utils/session-changes`: file-tool calls from the
 * transcript plus shell changes attributed to the command that made them, with automatic
 * changes excluded. Every difference is printed with its reason; a dropped path NEW cannot
 * explain is counted as UNEXPLAINED, which is the number this script exists to drive to zero.
 *
 * Read-only: it reads transcripts and change logs and writes nothing (blobs are not stored).
 *
 * Usage: bun scripts/session-changes-compare.ts [--recent 8] [--session <id>]... [--verbose] [--kept] [--json]
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { rawLogFiles } from "@app/agents/commands/changes";
import { type ChangeEvent, sessionChangesPath } from "@app/agents/lib/changes/log";
import { runTool } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { readJsonlRows } from "@genesiscz/utils/jsonl";
import { out } from "@genesiscz/utils/logger";
import {
    findClaudeTranscript,
    lastChangedTurns,
    loadSessionChanges,
    type TurnChanges,
} from "@genesiscz/utils/session-changes";
import { Command } from "commander";

interface Options {
    recent: string;
    session: string[];
    verbose?: boolean;
    kept?: boolean;
    json?: boolean;
}

interface Difference {
    turn: string;
    path: string;
    side: "dropped" | "added";
    reason: string;
    command?: string;
}

interface SessionReport {
    session: string;
    cwd: string | null;
    turnsCompared: number;
    logRows: number;
    oldFiles: number;
    newFiles: number;
    agree: number;
    dropped: Record<string, number>;
    added: Record<string, number>;
    unexplained: Difference[];
    lastTurn: { old: string | null; new: string | null };
    differences: Difference[];
    keptBash: { turn: string; path: string; confidence: string; command: string }[];
    ms: number;
}

function recentSessions(count: number): string[] {
    const dir = join(env.tools.getHome(), ".genesis-tools", "agents");
    const found: { id: string; mtime: number }[] = [];

    for (const id of readdirSync(dir)) {
        if (id.startsWith("_")) {
            continue;
        }

        try {
            found.push({ id, mtime: statSync(join(dir, id, "changes.jsonl")).mtimeMs });
        } catch {
            // A session directory without a change log has nothing to compare.
        }
    }

    return found
        .sort((a, b) => b.mtime - a.mtime)
        .map((item) => item.id)
        .filter((id) => findClaudeTranscript(id) !== null)
        .slice(0, count);
}

function bump(into: Record<string, number>, key: string): void {
    into[key] = (into[key] ?? 0) + 1;
}

function compareSession(session: string): SessionReport {
    const started = performance.now();
    const rows = readJsonlRows<ChangeEvent>(sessionChangesPath(session)).rows;
    const computed = loadSessionChanges({ sessionId: session, log: rows });
    const newByTurn = new Map<string, TurnChanges>(computed.turns.map((turn) => [turn.turnId, turn]));
    const oldByTurn = new Map<string, ChangeEvent[]>();

    for (const row of rows) {
        const list = oldByTurn.get(row.turn) ?? [];
        list.push(row);
        oldByTurn.set(row.turn, list);
    }

    const report: SessionReport = {
        session,
        cwd: rows[0]?.cwd ?? null,
        turnsCompared: 0,
        logRows: rows.length,
        oldFiles: 0,
        newFiles: 0,
        agree: 0,
        dropped: {},
        added: {},
        unexplained: [],
        lastTurn: { old: rows.at(-1)?.turn ?? null, new: lastChangedTurns(computed, 1)[0]?.turnId ?? null },
        differences: [],
        keptBash: [],
        ms: 0,
    };
    const turnIds = new Set([
        ...oldByTurn.keys(),
        ...computed.turns.filter((turn) => turn.files.length > 0).map((turn) => turn.turnId),
    ]);

    for (const turnId of turnIds) {
        report.turnsCompared++;
        const oldPaths = new Set(rawLogFiles(oldByTurn.get(turnId) ?? []).map((file) => file.path));
        const turn = newByTurn.get(turnId);
        const kept = new Map((turn?.files ?? []).map((file) => [file.path, file]));
        const excluded = new Map((turn?.excluded ?? []).map((item) => [item.path, item]));
        report.oldFiles += oldPaths.size;
        report.newFiles += kept.size;

        for (const path of oldPaths) {
            if (kept.has(path)) {
                report.agree++;
                continue;
            }

            const why = excluded.get(path);
            const difference: Difference = {
                turn: turnId,
                path,
                side: "dropped",
                reason: why?.reason ?? "UNEXPLAINED",
                command: why?.command,
            };
            bump(report.dropped, difference.reason);
            report.differences.push(difference);

            if (!why) {
                report.unexplained.push(difference);
            }
        }

        for (const [path, file] of kept) {
            if (file.via === "bash") {
                report.keptBash.push({ turn: turnId, path, confidence: file.confidence, command: file.command ?? "" });
            }

            if (oldPaths.has(path)) {
                continue;
            }

            const reason =
                file.via === "bash"
                    ? `bash-${file.confidence}${file.toolUseIds.includes("") ? "-unmatched-row" : ""}`
                    : `${file.via}${file.agentIds ? "-subagent" : ""} (the hook logs no file tools)`;
            bump(report.added, reason);
            report.differences.push({ turn: turnId, path, side: "added", reason, command: file.command });
        }
    }

    report.ms = Math.round(performance.now() - started);
    return report;
}

function short(text: string | undefined, max = 110): string {
    const flat = (text ?? "").replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function print(report: SessionReport, options: Options): void {
    out.println(`\n== ${report.session}  (${report.cwd ?? "?"})  ${report.ms} ms`);
    out.println(
        `   turns ${report.turnsCompared}  log rows ${report.logRows}  old files ${report.oldFiles}  new files ${report.newFiles}  agree ${report.agree}`
    );
    out.println(`   dropped by NEW: ${SafeJSON.stringify(report.dropped)}`);
    out.println(`   added by NEW:   ${SafeJSON.stringify(report.added)}`);
    out.println(
        `   last changed turn: old ${report.lastTurn.old?.slice(0, 8) ?? "-"}  new ${report.lastTurn.new?.slice(0, 8) ?? "-"}`
    );

    for (const item of report.unexplained) {
        out.println(`   UNEXPLAINED ${item.turn.slice(0, 8)} ${item.path}`);
    }

    if (options.verbose) {
        for (const item of report.differences) {
            out.println(
                `   ${item.side === "dropped" ? "-" : "+"} ${item.turn.slice(0, 8)} ${item.reason.padEnd(24)} ${item.path}  ${short(item.command, 80)}`
            );
        }
    }

    if (options.kept) {
        for (const item of report.keptBash) {
            out.println(
                `   kept-bash ${item.turn.slice(0, 8)} ${item.confidence.padEnd(6)} ${item.path}  <- ${short(item.command)}`
            );
        }
    }
}

const program = new Command()
    .name("session-changes-compare")
    .option("--recent <n>", "Compare the <n> most recent Claude sessions that have a change log", "8")
    .option(
        "--session <id>",
        "Also compare this session (repeatable)",
        (value: string, list: string[]) => [...list, value],
        []
    )
    .option("--verbose", "List every difference")
    .option("--kept", "List every shell-detected file NEW keeps, with its command, for review")
    .option("--json")
    .action((options: Options) => {
        const recent = Number(options.recent);

        // `nope` became NaN (no sessions) and `-2` meant "all but the last two", both silently.
        if (!Number.isInteger(recent) || recent < 0) {
            out.log.error(`--recent takes a whole number of at least 0, got ${options.recent}`);
            process.exitCode = 1;
            return;
        }

        const ids = [...new Set([...options.session, ...recentSessions(recent)])];
        const reports = ids.map(compareSession);

        if (options.json) {
            out.result(reports);
            return;
        }

        for (const report of reports) {
            print(report, options);
        }

        const totals = { dropped: {} as Record<string, number>, added: {} as Record<string, number> };

        for (const report of reports) {
            for (const [key, value] of Object.entries(report.dropped)) {
                totals.dropped[key] = (totals.dropped[key] ?? 0) + value;
            }

            for (const [key, value] of Object.entries(report.added)) {
                totals.added[key] = (totals.added[key] ?? 0) + value;
            }
        }

        out.println(
            `\n== TOTAL over ${reports.length} sessions, ${reports.reduce((sum, r) => sum + r.turnsCompared, 0)} turns`
        );
        out.println(`   dropped by NEW: ${SafeJSON.stringify(totals.dropped)}`);
        out.println(`   added by NEW:   ${SafeJSON.stringify(totals.added)}`);
        out.println(`   unexplained: ${reports.reduce((sum, r) => sum + r.unexplained.length, 0)}`);
    });

// Its own `--verbose` lists every difference; it is not the global log-level flag.
await runTool(program, { tool: "session-changes-compare", ignoreParams: ["verbose"] });
