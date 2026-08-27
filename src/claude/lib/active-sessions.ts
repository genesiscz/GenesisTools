import { existsSync, readFileSync } from "node:fs";
import { CMUX_REFS_PATH, type SessionCmuxRefs } from "@app/claude/lib/cmux/session-refs";
import { getSessionListing } from "@app/claude/lib/history/search";
import { getActiveSessionIds } from "@app/claude/lib/tail-list";
import { readTailBytes } from "@genesiscz/utils/claude/session.utils";
import type { ContentBlock } from "@genesiscz/utils/claude/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * Live Claude Code processes and the account each one runs as. The account is
 * per-process: `tools claude run <name>` exports TOOLS_CLAUDE_ACCOUNT into the
 * launched claude's environment (start.ts / run.ts), so reading it back off the
 * process table is the ONLY truthful answer to "which account does this pane
 * bill" — session files and statusline state do not record it.
 */

export type ClaudeProcessKind = "tui" | "sdk";

export interface PsProcessRow {
    pid: number;
    ppid: number;
    tty: string;
    startedAt: number | null;
    cpuTime: string;
    args: string;
}

export interface ActiveClaudeSession {
    pid: number;
    ppid: number;
    tty: string;
    startedAt: number | null;
    cpuTime: string;
    kind: ClaudeProcessKind;
    /** TOOLS_CLAUDE_ACCOUNT value; null = launched outside `tools claude run` (keychain login). */
    account: string | null;
    /** Set instead of account for ai-proxy sessions (TOOLS_CLAUDE_ACCOUNT=proxy:...). */
    proxyTarget: string | null;
    model: string | null;
    resumeId: string | null;
    cwd: string | null;
    /** Resolved session id: the --resume arg, or an unambiguous active-session match by cwd. */
    sessionId: string | null;
    /** Active sessions sharing this cwd when the id could not be pinned to one. */
    sessionCandidates: number;
    /** How the session id was established, so a guess never reads like a fact. */
    sessionSource: SessionIdSource;
    /** cmux surface (tab) this process runs in, resolved by tty. */
    surfaceRef: string | null;
    /**
     * How many live processes carry this same session id.
     *
     * A session CAN legitimately be open twice (`claude --resume <id>` in two panes), and
     * both copies write to one transcript. Showing 1 for each would hide that, so the count
     * is carried per row and rendered as a badge.
     */
    sessionInstances: number;
    /** `/rename` title, else the summary or first prompt. */
    sessionTitle: string | null;
    /** Last main-thread user message, cleaned of reminder/notification wrappers. */
    lastUserMessage: string | null;
    /** Epoch ms of the last main-thread turn — the statusline's `@HH:MM:SS`. */
    lastActivityAt: number | null;
}

export interface SessionTail {
    lastUserMessage: string | null;
    lastActivityAt: number | null;
}

/**
 * Last user message and last main-thread activity from transcript tail lines,
 * newest first.
 *
 * `isSidechain` lines are subagent traffic: counting them would report a
 * subagent's clock as the session's, which is exactly the mismatch that makes
 * an idle pane look busy. Same rule as the statusline's `@HH:MM:SS`
 * (see lib/usage/session-rows.ts).
 */
export function parseSessionTail(lines: string[]): SessionTail {
    const tail: SessionTail = { lastUserMessage: null, lastActivityAt: null };

    for (let i = lines.length - 1; i >= 0; i--) {
        let obj: {
            type?: unknown;
            timestamp?: unknown;
            isSidechain?: unknown;
            isMeta?: unknown;
            message?: { content?: string | ContentBlock[] };
        };

        try {
            obj = SafeJSON.parse(lines[i], { strict: true });
        } catch {
            continue;
        }

        if ((obj.type !== "user" && obj.type !== "assistant") || obj.isSidechain === true) {
            continue;
        }

        if (tail.lastActivityAt === null && typeof obj.timestamp === "string") {
            const parsed = Date.parse(obj.timestamp);

            if (Number.isFinite(parsed)) {
                tail.lastActivityAt = parsed;
            }
        }

        if (tail.lastUserMessage === null && obj.type === "user" && obj.isMeta !== true) {
            const text = cleanUserText(humanTextOf(obj.message?.content));

            if (text) {
                tail.lastUserMessage = text;
            }
        }

        if (tail.lastActivityAt !== null && tail.lastUserMessage !== null) {
            break;
        }
    }

    return tail;
}

/**
 * The text a HUMAN typed, ignoring tool results.
 *
 * Every tool return is also recorded as a `type: "user"` record whose content is
 * `tool_result` blocks, so a plain text extraction reports the last command's stdout
 * ("Bash completed with no output") as the user's last message — which is exactly
 * backwards for a column meant to answer "who asked this session to do something".
 */
export function humanTextOf(content: string | ContentBlock[] | undefined): string {
    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .filter((block) => block.type === "text")
        .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
        .join(" ");
}

/**
 * Strip the wrappers the harness injects around a prompt. Without this the
 * "last message" column shows a system reminder or a tool result instead of
 * what the user typed.
 */
export function cleanUserText(raw: string): string {
    return raw
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
        .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
        .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, "")
        .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** First slice. Grows up to TAIL_MAX_BYTES while the answer is still missing. */
const TAIL_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 1024 * 1024;

/**
 * A busy session's last 64 KiB can be nothing but tool results and subagent
 * traffic, which reports "—" for a pane that is plainly working. Grow the slice
 * until both answers are found or the file (or the cap) runs out — the same
 * doubling `extractTailUsage` uses for the usage TUI.
 */
async function readSessionTail(filePath: string): Promise<SessionTail> {
    try {
        const size = Number(Bun.file(filePath).size) || 0;
        let bytes = TAIL_BYTES;
        let tail: SessionTail = { lastUserMessage: null, lastActivityAt: null };

        for (;;) {
            tail = parseSessionTail(await readTailBytes(filePath, bytes));

            const complete = tail.lastActivityAt !== null && tail.lastUserMessage !== null;

            if (complete || size <= 0 || bytes >= size || bytes >= TAIL_MAX_BYTES) {
                return tail;
            }

            const next = Math.min(TAIL_MAX_BYTES, bytes * 2, size);

            if (next <= bytes) {
                return tail;
            }

            bytes = next;
        }
    } catch (error) {
        logger.debug({ error, filePath }, "[who] session tail read failed");
        return { lastUserMessage: null, lastActivityAt: null };
    }
}

/** `ps -axww -o pid=,ppid=,tty=,lstart=,time=,args=` — lstart is always 5 tokens. */
export function parsePsLine(line: string): PsProcessRow | null {
    const tokens = line.trim().split(/\s+/);

    if (tokens.length < 10) {
        return null;
    }

    const pid = Number(tokens[0]);
    const ppid = Number(tokens[1]);

    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
        return null;
    }

    // lstart = "Wed Aug 26 18:13:02 2026" (tokens 3..7)
    const [, , tty, , mon, day, clock, year] = tokens;
    const parsed = Date.parse(`${mon} ${day}, ${year} ${clock}`);

    return {
        pid,
        ppid,
        tty,
        startedAt: Number.isFinite(parsed) ? parsed : null,
        cpuTime: tokens[8],
        args: tokens.slice(9).join(" "),
    };
}

/** The real claude binary is a session; bun launchers and MCP children are not. */
export function classifyClaudeArgs(args: string): ClaudeProcessKind | null {
    const exe = args.split(/\s+/)[0] ?? "";
    const base = exe.split("/").pop() ?? "";

    if (base === "claude") {
        return "tui";
    }

    if (base === "gt-claude") {
        return "sdk";
    }

    return null;
}

export function extractLaunchDetails(args: string): { resumeId: string | null; model: string | null } {
    const tokens = args.split(/\s+/);
    let resumeId: string | null = null;
    let model: string | null = null;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (token === "--resume" || token === "-r") {
            const next = tokens[i + 1];

            if (next && /^[\w-]+$/.test(next)) {
                resumeId = next;
            }
        } else if (token.startsWith("--resume=")) {
            resumeId = token.slice("--resume=".length) || null;
        } else if (token === "--model") {
            model = tokens[i + 1] ?? null;
        } else if (token.startsWith("--model=")) {
            model = token.slice("--model=".length) || null;
        }
    }

    return { resumeId, model };
}

/** From a `ps -e` args+env line: the TOOLS_CLAUDE_ACCOUNT value, split into account vs proxy target. */
export function parseAccountEnv(envArgs: string): { account: string | null; proxyTarget: string | null } {
    const match = envArgs.match(/(?:^|\s)TOOLS_CLAUDE_ACCOUNT=(\S+)/);

    if (!match) {
        return { account: null, proxyTarget: null };
    }

    const value = match[1];

    if (value.startsWith("proxy:")) {
        return { account: null, proxyTarget: value.slice("proxy:".length) };
    }

    return { account: value, proxyTarget: null };
}

export type SessionIdSource = "resume-arg" | "hook-tty" | "cwd-unique" | "none";

export interface SessionIdAssignment {
    sessionId: string | null;
    candidates: number;
    source: SessionIdSource;
}

/**
 * `surface surface:193 [terminal] "title" tty=ttys020` lines from `cmux top --all`.
 *
 * This is the link the hook journal is missing: it records which cmux SURFACE a session
 * runs on, but a surface ref means nothing to `ps`. The tty is the shared key.
 */
export function parseCmuxSurfaceTtys(output: string): Map<string, string> {
    const result = new Map<string, string>();

    for (const match of output.matchAll(/surface\s+(surface:\d+)\b[^\n]*?\btty=(\S+)/g)) {
        result.set(match[1], match[2]);
    }

    return result;
}

/** Latest journal line per session — later lines win, as the hook appends. */
export function latestRefsBySession(raw: string): Map<string, SessionCmuxRefs> {
    const latest = new Map<string, SessionCmuxRefs>();

    for (const line of raw.split("\n")) {
        if (!line.trim()) {
            continue;
        }

        let entry: SessionCmuxRefs;

        try {
            entry = SafeJSON.parse(line, { jsonl: true }) as SessionCmuxRefs;
        } catch {
            continue;
        }

        if (!entry?.sessionId) {
            continue;
        }

        const seen = latest.get(entry.sessionId);

        if (!seen || (entry.at ?? 0) >= (seen.at ?? 0)) {
            latest.set(entry.sessionId, entry);
        }
    }

    return latest;
}

export interface SessionHint {
    sessionId: string;
    tty: string;
    cwd: string | null;
}

/**
 * Session → tty, by joining the hook journal to the live cmux surface list.
 *
 * A surface REF is renumbered when cmux restarts, so a stale journal line can name a ref
 * another session now owns. The surface UUID is stable, so it is preferred; the ref is a
 * fallback, and `assignSessionIds` additionally requires the cwd to agree before trusting
 * either — a renumbered ref pointing at an unrelated pane will not match a cwd.
 */
export function buildSessionHints(
    refs: Map<string, SessionCmuxRefs>,
    ttyBySurfaceRef: Map<string, string>,
    ttyBySurfaceId: Map<string, string> = new Map()
): SessionHint[] {
    const hints: SessionHint[] = [];

    for (const [sessionId, entry] of refs) {
        const tty =
            (entry.surfaceId ? ttyBySurfaceId.get(entry.surfaceId) : undefined) ??
            (entry.surfaceRef ? ttyBySurfaceRef.get(entry.surfaceRef) : undefined);

        if (tty) {
            hints.push({ sessionId, tty, cwd: entry.cwd });
        }
    }

    return hints;
}

/**
 * Pin each process to a session id, strongest evidence first:
 *
 * 1. `--resume <id>` in argv — the process says so itself.
 * 2. The SessionStart hook's journal, joined to the live cmux surface list by tty. This is
 *    the only source that knows a fresh, never-resumed session's id, which is why `who`
 *    used to print "—" for exactly the panes you most wanted to identify.
 * 3. A cwd with exactly one unclaimed active session and one unresolved process.
 *
 * Anything else stays null with the candidate count, because guessing here would point
 * `cmux focus` at the wrong pane.
 */
export function assignSessionIds(
    procs: Array<{ pid: number; cwd: string | null; resumeId: string | null; tty?: string }>,
    activeSessions: Array<{ sessionId: string; cwd: string | null }>,
    hints: SessionHint[] = []
): Map<number, SessionIdAssignment> {
    const result = new Map<number, SessionIdAssignment>();
    const claimed = new Set<string>();

    for (const proc of procs) {
        if (proc.resumeId) {
            result.set(proc.pid, { sessionId: proc.resumeId, candidates: 1, source: "resume-arg" });
            claimed.add(proc.resumeId);
        }
    }

    // A tty hosts one interactive session at a time, so a tty shared by two hints means the
    // journal is stale for at least one of them. Dropping both beats picking the wrong one.
    const ttyCounts = new Map<string, number>();

    for (const hint of hints) {
        ttyCounts.set(hint.tty, (ttyCounts.get(hint.tty) ?? 0) + 1);
    }

    const hintByTty = new Map<string, SessionHint>();

    for (const hint of hints) {
        if (ttyCounts.get(hint.tty) === 1 && !claimed.has(hint.sessionId)) {
            hintByTty.set(hint.tty, hint);
        }
    }

    for (const proc of procs) {
        if (result.has(proc.pid) || !proc.tty) {
            continue;
        }

        const hint = hintByTty.get(proc.tty);

        if (!hint || claimed.has(hint.sessionId)) {
            continue;
        }

        // Corroboration: a renumbered surface ref can name the wrong session, and a wrong
        // id here sends `focus` to someone else's pane. Matching cwds makes that a
        // two-signal agreement rather than a lookup.
        if (hint.cwd && proc.cwd && hint.cwd !== proc.cwd) {
            continue;
        }

        result.set(proc.pid, { sessionId: hint.sessionId, candidates: 1, source: "hook-tty" });
        claimed.add(hint.sessionId);
    }

    const byCwd = new Map<string, string[]>();

    for (const session of activeSessions) {
        if (!session.cwd || claimed.has(session.sessionId)) {
            continue;
        }

        const list = byCwd.get(session.cwd) ?? [];
        list.push(session.sessionId);
        byCwd.set(session.cwd, list);
    }

    const unresolved = procs.filter((proc) => !result.has(proc.pid));

    for (const proc of unresolved) {
        const candidates = proc.cwd ? (byCwd.get(proc.cwd) ?? []) : [];
        const siblings = unresolved.filter((other) => other.cwd === proc.cwd).length;

        if (candidates.length === 1 && siblings === 1) {
            result.set(proc.pid, { sessionId: candidates[0], candidates: 1, source: "cwd-unique" });
        } else {
            result.set(proc.pid, { sessionId: null, candidates: candidates.length, source: "none" });
        }
    }

    return result;
}

export function invertSurfaceTtys(ttyBySurfaceRef: Map<string, string>): Map<string, string> {
    const surfaceByTty = new Map<string, string>();

    for (const [surfaceRef, tty] of ttyBySurfaceRef) {
        // A tty belongs to exactly one surface; a duplicate means the listing is mid-change,
        // and naming either one would be a guess.
        if (surfaceByTty.has(tty)) {
            surfaceByTty.set(tty, "");
            continue;
        }

        surfaceByTty.set(tty, surfaceRef);
    }

    return surfaceByTty;
}

/** Count of live processes per session id, so a twice-opened session is visible. */
export function countSessionInstances(sessionIds: Array<string | null>): Map<string, number> {
    const counts = new Map<string, number>();

    for (const id of sessionIds) {
        if (id) {
            counts.set(id, (counts.get(id) ?? 0) + 1);
        }
    }

    return counts;
}

interface CmuxContext {
    hints: SessionHint[];
    surfaceByTty: Map<string, string>;
}

/** Journal + live cmux surfaces. Both are optional: no cmux simply means no hints. */
async function readCmuxContext(runner: (cmd: string[]) => Promise<string>): Promise<CmuxContext> {
    const empty: CmuxContext = { hints: [], surfaceByTty: new Map() };

    try {
        const top = await runner(["cmux", "top", "--all"]);
        const ttyBySurfaceRef = parseCmuxSurfaceTtys(top);
        const surfaceByTty = invertSurfaceTtys(ttyBySurfaceRef);

        if (!existsSync(CMUX_REFS_PATH)) {
            return { hints: [], surfaceByTty };
        }

        const refs = latestRefsBySession(readFileSync(CMUX_REFS_PATH, "utf8"));

        return { hints: buildSessionHints(refs, ttyBySurfaceRef), surfaceByTty };
    } catch (error) {
        logger.debug({ error }, "[who] cmux session hints unavailable");
        return empty;
    }
}

async function runCapture(cmd: string[]): Promise<string> {
    const proc = Bun.spawn({ cmd, stdio: ["ignore", "pipe", "pipe"] });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;

    if (exitCode !== 0 && stdout.trim().length === 0) {
        logger.debug({ cmd: cmd[0], exitCode, stderr: stderr.slice(0, 400) }, "[who] capture command failed");
    }

    return stdout;
}

/** `lsof -a -d cwd -p <pids> -Fpn` → pid → cwd. */
export function parseLsofCwd(output: string): Map<number, string> {
    const result = new Map<number, string>();
    let pid: number | null = null;

    for (const line of output.split("\n")) {
        if (line.startsWith("p")) {
            const parsed = Number(line.slice(1));
            pid = Number.isInteger(parsed) ? parsed : null;
        } else if (line.startsWith("n") && pid !== null) {
            result.set(pid, line.slice(1));
        }
    }

    return result;
}

/**
 * An SDK/MCP child that shares a tty with a TUI session is that session's own helper
 * (`tools claude mcp`), not a separate agent. It bills the same account and adds a row that
 * reads like an unidentified session, so it is hidden unless asked for. A headless agent
 * with no TUI on its tty is a real, separately billable session and always shows.
 */
export function isHelperChild(
    proc: { kind: ClaudeProcessKind; tty: string },
    all: Array<{ kind: ClaudeProcessKind; tty: string }>
): boolean {
    if (proc.kind !== "sdk" || proc.tty === "??") {
        return false;
    }

    return all.some((other) => other.kind === "tui" && other.tty === proc.tty);
}

export async function listActiveClaudeSessions(): Promise<ActiveClaudeSession[]> {
    // BSD flag syntax on purpose: the dashless `e` appends the environment,
    // while `-e` merely means "every process" and shows no env at all.
    const [argvOut, envOut] = await Promise.all([
        runCapture(["ps", "axww", "-o", "pid=,ppid=,tty=,lstart=,time=,args="]),
        runCapture(["ps", "axeww", "-o", "pid=,args="]),
    ]);

    const rows: Array<PsProcessRow & { kind: ClaudeProcessKind }> = [];

    for (const line of argvOut.split("\n")) {
        const row = parsePsLine(line);
        const kind = row ? classifyClaudeArgs(row.args) : null;

        if (row && kind) {
            rows.push({ ...row, kind });
        }
    }

    if (rows.length === 0) {
        return [];
    }

    const envByPid = new Map<number, string>();

    for (const line of envOut.split("\n")) {
        const match = line.match(/^\s*(\d+)\s+(.*)$/);

        if (match) {
            envByPid.set(Number(match[1]), match[2]);
        }
    }

    const pids = rows.map((row) => row.pid);
    const lsofOut = await runCapture(["lsof", "-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"]);
    const cwdByPid = parseLsofCwd(lsofOut);

    const partial = rows.map((row) => {
        const { account, proxyTarget } = parseAccountEnv(envByPid.get(row.pid) ?? "");
        const { resumeId, model } = extractLaunchDetails(row.args);

        return {
            ...row,
            account,
            proxyTarget,
            model,
            resumeId,
            cwd: cwdByPid.get(row.pid) ?? null,
        };
    });

    let activeSessions: Array<{ sessionId: string; cwd: string | null }> = [];
    const pathBySessionId = new Map<string, string>();
    const titleBySessionId = new Map<string, string>();

    try {
        const activeIds = getActiveSessionIds();
        const listing = await getSessionListing({ excludeSubagents: true });

        for (const session of listing.sessions) {
            if (!session.sessionId) {
                continue;
            }

            pathBySessionId.set(session.sessionId, session.filePath);
            const title = session.customTitle ?? session.summary ?? session.firstPrompt;

            if (title) {
                titleBySessionId.set(session.sessionId, title.replace(/\s+/g, " ").trim());
            }
        }

        activeSessions = listing.sessions
            .filter((s): s is typeof s & { sessionId: string } => s.sessionId !== null && activeIds.has(s.sessionId))
            .map((s) => ({ sessionId: s.sessionId, cwd: s.cwd }));
    } catch (error) {
        logger.debug({ error }, "[who] active session listing failed — session ids limited to --resume args");
    }

    const cmux = await readCmuxContext(runCapture);
    const assignments = assignSessionIds(partial, activeSessions, cmux.hints);
    // Only TUI processes count: an MCP/SDK child shares its parent's tty, and counting it
    // would report every ordinary session as "open twice".
    const instances = countSessionInstances(
        partial.filter((proc) => proc.kind === "tui").map((proc) => assignments.get(proc.pid)?.sessionId ?? null)
    );

    // Only resolved sessions get a tail read: an unresolved pid has no single
    // transcript to quote, and guessing one would attribute another session's
    // prompt to this process.
    const tails = new Map<string, SessionTail>();
    await Promise.all(
        [...new Set([...assignments.values()].map((a) => a.sessionId).filter((id): id is string => id !== null))].map(
            async (sessionId) => {
                const filePath = pathBySessionId.get(sessionId);

                if (filePath) {
                    tails.set(sessionId, await readSessionTail(filePath));
                }
            }
        )
    );

    return partial.map((proc) => {
        const assignment: SessionIdAssignment = assignments.get(proc.pid) ?? {
            sessionId: null,
            candidates: 0,
            source: "none",
        };
        const tail = assignment.sessionId ? tails.get(assignment.sessionId) : undefined;

        return {
            pid: proc.pid,
            ppid: proc.ppid,
            tty: proc.tty,
            startedAt: proc.startedAt,
            cpuTime: proc.cpuTime,
            kind: proc.kind,
            account: proc.account,
            proxyTarget: proc.proxyTarget,
            model: proc.model,
            resumeId: proc.resumeId,
            cwd: proc.cwd,
            sessionId: assignment.sessionId,
            sessionCandidates: assignment.candidates,
            sessionSource: assignment.source,
            surfaceRef: cmux.surfaceByTty.get(proc.tty) || null,
            sessionInstances: assignment.sessionId ? (instances.get(assignment.sessionId) ?? 1) : 0,
            sessionTitle: assignment.sessionId ? (titleBySessionId.get(assignment.sessionId) ?? null) : null,
            lastUserMessage: tail?.lastUserMessage ?? null,
            lastActivityAt: tail?.lastActivityAt ?? null,
        };
    });
}
