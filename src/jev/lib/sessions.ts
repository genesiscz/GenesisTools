import { readdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

/** One parsed pino row from a day log. Everything beyond these keys is kept as-is. */
export interface JevLogRow {
    time: string;
    level: number;
    pid: number;
    msg: string;
    component?: string;
    [key: string]: unknown;
}

/** The commands that open a session a reader would want to replay. */
const SESSION_STARTS: Record<string, string> = {
    "jev listen starting": "listen",
    "jev loop starting": "loop",
    "jev watch starting": "watch",
};

export interface JevSession {
    pid: number;
    command: string;
    day: string;
    startedAt: string;
    endedAt: string;
    app?: string;
    provider?: string;
    scope?: string;
    targetSource?: string;
    dryRun?: boolean;
    /** Every row of this pid from the start row onwards, in file order. */
    rows: JevLogRow[];
}

export interface JevDecision {
    time: string;
    status: string;
    reason: string;
    choice?: string;
    label?: string;
    probability?: number;
    transcript: string;
}

export function logsDirectory(): string {
    return join(env.tools.getHome(), ".genesis-tools", "logs");
}

/** Day files only, newest first; the `-profiling` siblings are a different format. */
export function logDays(directory = logsDirectory()): string[] {
    let names: string[];
    try {
        names = readdirSync(directory);
    } catch {
        return [];
    }

    return names
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.log$/.test(name))
        .map((name) => name.slice(0, 10))
        .sort()
        .reverse();
}

export function parseLogLine(line: string): JevLogRow | null {
    if (line.length === 0 || !line.startsWith("{")) {
        return null;
    }

    let value: unknown;
    try {
        value = SafeJSON.parse(line, { strict: true });
    } catch {
        return null;
    }

    if (typeof value !== "object" || value === null) {
        return null;
    }

    const row = value as Record<string, unknown>;
    if (typeof row.time !== "string" || typeof row.msg !== "string") {
        return null;
    }

    const pid = basePid(line);
    if (pid === null) {
        return null;
    }

    return { ...row, pid } as unknown as JevLogRow;
}

/**
 * pino writes its own `pid` first, right before `hostname`. A payload field also called `pid`
 * (a target app's pid, say) parses last and wins, which would file the row under the wrong
 * process, so the emitting pid is read from the base position instead of the parsed object.
 * Logs written before that collision was fixed are still readable this way.
 */
export function basePid(line: string): number | null {
    const match = /"pid":(\d+),"hostname":/.exec(line);
    return match ? Number(match[1]) : null;
}

function text(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/**
 * A session is one pid from its `jev <command> starting` row to that pid's last row of the day.
 * Pids are recycled across days but not within one, so the day file is the natural boundary.
 */
export function groupSessions(rows: JevLogRow[], day: string): JevSession[] {
    const open = new Map<number, JevSession>();
    const sessions: JevSession[] = [];
    for (const row of rows) {
        absorb(row, day, open, sessions);
    }

    return sessions;
}

function absorb(row: JevLogRow, day: string, open: Map<number, JevSession>, sessions: JevSession[]): void {
    const command = SESSION_STARTS[row.msg];
    if (command !== undefined) {
        const session: JevSession = {
            pid: row.pid,
            command,
            day,
            startedAt: row.time,
            endedAt: row.time,
            app: text(row.app),
            provider: text(row.provider),
            scope: text(row.scope),
            targetSource: text(row.targetSource),
            dryRun: typeof row.dryRun === "boolean" ? row.dryRun : undefined,
            rows: [row],
        };
        open.set(row.pid, session);
        sessions.push(session);
        return;
    }

    const session = open.get(row.pid);
    if (session) {
        session.rows.push(row);
        session.endedAt = row.time;
    }
}

/**
 * A day log holds every tool's rows and runs to tens of megabytes, so the scan parses only the
 * lines that can belong to a Jev session: a start marker, or a pid one is already open for.
 */
export async function readSessions(day: string, directory = logsDirectory()): Promise<JevSession[]> {
    const file = Bun.file(join(directory, `${day}.log`));
    if (!(await file.exists())) {
        return [];
    }

    const open = new Map<number, JevSession>();
    const sessions: JevSession[] = [];
    const decoder = new TextDecoder();
    let pending = "";
    const take = (line: string): void => {
        const isStart = Object.keys(SESSION_STARTS).some((marker) => line.includes(marker));
        if (!isStart && !hasOpenPid(line, open)) {
            return;
        }

        const row = parseLogLine(line);
        if (row === null) {
            return;
        }

        absorb(row, day, open, sessions);
    };

    for await (const chunk of file.stream()) {
        pending += decoder.decode(chunk, { stream: true });
        let cut = pending.indexOf("\n");
        while (cut !== -1) {
            take(pending.slice(0, cut));
            pending = pending.slice(cut + 1);
            cut = pending.indexOf("\n");
        }
    }

    take(pending + decoder.decode());
    return sessions;
}

function hasOpenPid(line: string, open: Map<number, JevSession>): boolean {
    for (const pid of open.keys()) {
        if (line.includes(`"pid":${pid},`)) {
            return true;
        }
    }

    return false;
}

export function decisionsOf(session: JevSession): JevDecision[] {
    const decisions: JevDecision[] = [];
    for (const row of session.rows) {
        if (row.msg !== "listen decision") {
            continue;
        }

        decisions.push({
            time: row.time,
            status: text(row.status) ?? "?",
            reason: text(row.reason) ?? "?",
            choice: text(row.choice),
            label: text(row.label),
            probability: typeof row.probability === "number" ? row.probability : undefined,
            transcript: text(row.transcript) ?? "",
        });
    }

    return decisions;
}

/** Every distinct thing the user said, in order, with the repeated partials collapsed. */
export function transcriptOf(session: JevSession): string[] {
    const said: string[] = [];
    for (const decision of decisionsOf(session)) {
        const phrase = decision.transcript.trim();
        if (phrase.length > 0 && phrase !== said[said.length - 1]) {
            said.push(phrase);
        }
    }

    return said;
}

export function errorsOf(session: JevSession): { time: string; msg: string; error: string }[] {
    const found: { time: string; msg: string; error: string }[] = [];
    for (const row of session.rows) {
        if (row.level < 40) {
            continue;
        }

        const error = row.error;
        const message =
            typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
                ? (error as { message: string }).message
                : undefined;
        if (message !== undefined) {
            found.push({ time: row.time, msg: row.msg, error: message });
        }
    }

    return found;
}

export function countByStatus(decisions: JevDecision[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const decision of decisions) {
        counts[decision.status] = (counts[decision.status] ?? 0) + 1;
    }

    return counts;
}
