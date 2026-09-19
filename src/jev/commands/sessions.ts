import { suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { failPlain } from "../lib/cli-output";
import {
    countByStatus,
    decisionsOf,
    errorsOf,
    type JevSession,
    logDays,
    readSessions,
    transcriptOf,
} from "../lib/sessions";

const { log } = logger.scoped("jev-sessions");
const DEFAULT_DAYS = 3;
const DEFAULT_LIMIT = 20;

interface SessionsOptions {
    day?: string;
    days: string;
    limit: string;
    json?: boolean;
}

export function registerSessions(program: Command): void {
    program
        .command("sessions")
        .alias("logs")
        .description("Recent jev listen/loop/watch runs read back out of the day logs")
        .argument("[ref]", "A pid, a 1-based row number from the list, or 'last' for the newest run")
        .option("--day <date>", "Read one day only, as YYYY-MM-DD")
        .option("--days <n>", "How many recent days to scan", String(DEFAULT_DAYS))
        .option("--limit <n>", "Rows in the list", String(DEFAULT_LIMIT))
        .option("--json", "Machine-readable output")
        .action(async (ref: string | undefined, options: SessionsOptions) => {
            try {
                await runSessions(ref, options);
            } catch (error) {
                failPlain(error, { command: "jev sessions" });
            }
        });
}

async function collect(options: SessionsOptions): Promise<JevSession[]> {
    const days = options.day ? [options.day] : logDays().slice(0, Math.max(1, Number(options.days) || DEFAULT_DAYS));
    const found: JevSession[] = [];
    for (const day of days) {
        found.push(...(await readSessions(day)));
    }

    log.debug({ days, sessions: found.length }, "scanned day logs for jev sessions");
    return found.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

async function runSessions(ref: string | undefined, options: SessionsOptions): Promise<void> {
    const sessions = await collect(options);
    if (sessions.length === 0) {
        ui.warn("No jev listen, loop or watch runs in the scanned day logs.");
        ui.info(suggestCommand("tools jev sessions", { add: ["--days", "7"] }));
        return;
    }

    const picked = ref === undefined ? null : pick(sessions, ref);
    if (ref !== undefined && picked === null) {
        ui.err(`No session matches "${ref}".`);
        process.exitCode = 1;
        return;
    }

    if (picked) {
        showOne(picked, options.json === true);
        return;
    }

    showList(sessions.slice(0, Math.max(1, Number(options.limit) || DEFAULT_LIMIT)), options.json === true);
}

function pick(sessions: JevSession[], ref: string): JevSession | null {
    if (ref === "last") {
        return sessions[0] ?? null;
    }

    const byPid = sessions.find((session) => String(session.pid) === ref);
    if (byPid) {
        return byPid;
    }

    const index = Number(ref);
    if (Number.isInteger(index) && index >= 1 && index <= sessions.length) {
        return sessions[index - 1] ?? null;
    }

    return null;
}

function clock(iso: string): string {
    return new Date(iso).toLocaleTimeString("en-GB", { hour12: false });
}

function seconds(session: JevSession): string {
    const ms = Date.parse(session.endedAt) - Date.parse(session.startedAt);
    return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function outcome(session: JevSession): { tone: "ok" | "warn" | "err" | "dim"; label: string } {
    const errors = errorsOf(session);
    if (errors.length > 0) {
        return { tone: "err", label: `${errors.length} error` };
    }

    const counts = countByStatus(decisionsOf(session));
    if ((counts.act ?? 0) > 0) {
        return { tone: "ok", label: `${counts.act} act` };
    }

    if ((counts.would ?? 0) > 0) {
        return { tone: "ok", label: `${counts.would} would (dry run)` };
    }

    if ((counts.abstain ?? 0) > 0) {
        return { tone: "warn", label: `${counts.abstain} abstain` };
    }

    return { tone: "dim", label: "nothing said" };
}

function showList(sessions: JevSession[], json: boolean): void {
    if (json) {
        out.result(
            sessions.map((session) => ({
                pid: session.pid,
                command: session.command,
                day: session.day,
                startedAt: session.startedAt,
                app: session.app,
                provider: session.provider,
                dryRun: session.dryRun,
                counts: countByStatus(decisionsOf(session)),
                said: transcriptOf(session),
                errors: errorsOf(session).map((entry) => entry.error),
            }))
        );
        return;
    }

    renderCliHeader("Jev sessions", "newest first; open one with tools jev sessions <n>");
    const table = createBoxTable(["#", "WHEN", "CMD", "APP", "STT", "OUTCOME", "SAID"]);
    sessions.forEach((session, index) => {
        const verdict = outcome(session);
        table.push([
            pc.dim(String(index + 1)),
            `${session.day.slice(5)} ${clock(session.startedAt)} ${pc.dim(seconds(session))}`,
            session.command,
            truncateDisplay(session.app ?? "", 18),
            truncateDisplay(session.provider ?? "", 9),
            formatDotStatus(verdict.tone, verdict.label),
            truncateDisplay(transcriptOf(session).join(" / "), 40),
        ]);
    });
    out.println(table.toString());
    out.println(pc.dim(`  ${sessions.length} sessions · open one with "tools jev sessions <n>" or "… last"`));
}

function showOne(session: JevSession, json: boolean): void {
    if (json) {
        out.result({ ...session, said: transcriptOf(session), counts: countByStatus(decisionsOf(session)) });
        return;
    }

    renderCliHeader(
        `jev ${session.command} · pid ${session.pid}`,
        `${session.day} ${clock(session.startedAt)} → ${clock(session.endedAt)} (${seconds(session)})`
    );
    ui.kv("app", `${session.app ?? "-"} (${session.targetSource ?? "-"}, scope ${session.scope ?? "-"})`);
    ui.kv("stt", `${session.provider ?? "-"}${session.dryRun === true ? ", dry run" : ""}`);

    ui.section("Timeline");
    for (const row of session.rows) {
        const line = describe(row);
        if (line !== null) {
            ui.raw(`  ${pc.dim(clock(row.time))}  ${line}`);
        }
    }

    const errors = errorsOf(session);
    if (errors.length > 0) {
        ui.section("Errors");
        for (const entry of errors) {
            ui.err(`  ${clock(entry.time)}  ${entry.msg}: ${entry.error}`);
        }
    }

    const counts = countByStatus(decisionsOf(session));
    ui.section("Counts");
    ui.raw(
        `  ${Object.entries(counts)
            .map(([status, count]) => `${status} ${count}`)
            .join(" · ")}`
    );
}

function number(value: unknown): string {
    return typeof value === "number" ? value.toFixed(2) : "-";
}

/** One line per row a human would want, and nothing for the rows they would not. */
function describe(row: Record<string, unknown> & { msg: string }): string | null {
    switch (row.msg) {
        case "jev listen starting":
        case "jev loop starting":
        case "jev watch starting":
            return pc.cyan("session start");
        case "listen decision": {
            const transcript = typeof row.transcript === "string" ? row.transcript : "";
            if (transcript.length === 0) {
                return null;
            }

            const status = String(row.status ?? "?");
            const paint = status === "act" ? pc.green : status === "abstain" ? pc.yellow : pc.white;
            return `${paint(status.padEnd(8))} ${String(row.reason ?? "").padEnd(12)} ${pc.dim(`p=${number(row.probability)}`)}  ${pc.bold(`"${transcript}"`)}`;
        }
        case "admission gate refused":
            return pc.yellow(
                `  gate refused  p=${number(row.probability)} margin=${number(row.margin)} confidence=${number(row.confidence)} over ${String(row.allowed ?? "?")} candidates`
            );
        case "admission gate passed":
            return pc.dim(
                `  gate passed   p=${number(row.probability)} choice=${String(row.choice ?? "-")} over ${String(row.allowed ?? "?")} candidates`
            );
        case "native see ok":
            return pc.dim(`  see ${String(row.elements ?? "?")} elements`);
        case "menu items observed":
            return pc.dim(`  menus ${String(row.items ?? "?")} items`);
        case "native act ok":
            return pc.green(`  acted`);
        case "AX tree too deep; retrying deeper":
            return pc.yellow(`  AX tree too deep; retrying at depth ${String(row.depth ?? "?")}`);
        default:
            return null;
    }
}
