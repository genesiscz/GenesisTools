import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadPins, recordPin } from "@genesiscz/utils/agent-sessions/pins";
import {
    appendClaudeCodeModePin,
    checkCodeModePair,
    claudeCodeModePin,
    copySourceOf,
    type PairCheck,
    type SessionCopyScan,
    writeSessionCopy,
} from "@genesiscz/utils/agent-sessions/readers/claude-fork";
import {
    AmbiguousSessionIdError,
    canonicalClaudeTranscript,
} from "@genesiscz/utils/agent-sessions/readers/claude-locate";
import {
    claudeSessionHolderProcesses,
    claudeSessionHolders,
    isClaudeLaunchProcess,
} from "@genesiscz/utils/agent-sessions/readers/claude-peer";
import {
    appendClaudeTitle,
    lastClaudeAiTitleIn,
    lastClaudeTitleIn,
} from "@genesiscz/utils/agent-sessions/readers/claude-title";
import { findSessionsByTitle } from "@genesiscz/utils/ai/transcripts/session-title";
import { isJsonObject, SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { ancestry, readProcess } from "@genesiscz/utils/process/processes";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { classifyPid, readProcessCommand } from "@genesiscz/utils/process-identity";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";

const { log } = logger.scoped("claude-fork");

export const DEFAULT_BACKUP_SUFFIX = "-without-codemode";

export interface CodeModeForkPlan {
    /** The session that gets the Code Mode marker and keeps its id, so every link to it reaches Code Mode. */
    sessionId: string;
    sessionPath: string;
    title: string;
    /** The copy without Code Mode, under a new id. */
    backupId: string;
    backupPath: string;
    backupTitle: string;
}

export type CodeModeForkOutcome =
    | { kind: "refused"; reason: string }
    /** A Claude Code process has the session open; nothing was written. */
    | { kind: "busy"; sessionId: string; holders: number[]; holderStarts: Record<number, number>; reason: string }
    | { kind: "planned"; plan: CodeModeForkPlan }
    | { kind: "forked"; plan: CodeModeForkPlan; backup: SessionCopyScan };

export interface CodeModeForkOptions {
    /** A session id, a prefix of eight characters or more, or the session's exact `/rename` title. */
    session: string;
    /** A new title for the Code Mode session; default: its own title. */
    title?: string;
    /** Added to the title of the copy without Code Mode. */
    backupSuffix?: string;
    dryRun?: boolean;
}

/** An id or an id prefix first, then a `/rename` title. Only an exact title counts: a fork of the wrong session is two sessions to undo. */
async function findTranscript(session: string): Promise<string | CodeModeForkOutcome> {
    try {
        const byId = await canonicalClaudeTranscript(session);

        if (byId) {
            return byId;
        }
    } catch (error) {
        if (error instanceof AmbiguousSessionIdError) {
            return { kind: "refused", reason: `${session} starts several sessions: ${error.ids.join(", ")}.` };
        }

        throw error;
    }

    const wanted = session.trim().toLowerCase();
    const hits = findSessionsByTitle(session, { provider: "claude" });
    const exact = hits.filter((hit) => hit.title.trim().toLowerCase() === wanted);
    const ids = [...new Set(exact.map((hit) => hit.sessionId))];

    if (ids.length > 1) {
        return { kind: "refused", reason: `Several sessions are titled "${session}": ${ids.join(", ")}. Pass an id.` };
    }

    const [id] = ids;

    if (id) {
        return (await canonicalClaudeTranscript(id)) ?? { kind: "refused", reason: `No transcript for session ${id}.` };
    }

    const near = hits.map((hit) => `${hit.sessionId.slice(0, 8)} "${hit.title}"`).slice(0, 5);
    return {
        kind: "refused",
        reason: `No Claude session with the id or title ${session}.${near.length > 0 ? ` Titles that contain it: ${near.join(", ")}.` : ""}`,
    };
}

/**
 * Moves a session into Code Mode: a copy under a new id keeps the conversation without Code Mode, then the session
 * itself gets the Code Mode marker and keeps its id. It refuses while a Claude Code process has the session open: that
 * process would keep writing to the file and could write its own name over the rename.
 */
export async function forkSessionIntoCodeMode(options: CodeModeForkOptions): Promise<CodeModeForkOutcome> {
    const found = await findTranscript(options.session);

    if (typeof found !== "string") {
        return found;
    }

    return options.dryRun
        ? forkClosedSession(options, found)
        : withFileLock(`${found}.codemode.lock`, () => forkClosedSession(options, found));
}

async function forkClosedSession(options: CodeModeForkOptions, sessionPath: string): Promise<CodeModeForkOutcome> {
    const statePath = `${sessionPath}.codemode-fork.json`;
    const recovery: unknown = existsSync(statePath)
        ? SafeJSON.parse(readFileSync(statePath, "utf8"), { strict: true })
        : null;
    const saved =
        isJsonObject(recovery) &&
        isJsonObject(recovery.plan) &&
        recovery.plan.sessionPath === sessionPath &&
        typeof recovery.plan.backupId === "string" &&
        /^[a-f0-9-]{36}$/.test(recovery.plan.backupId)
            ? recovery
            : null;
    const sessionId = basename(sessionPath, ".jsonl");
    const processes = claudeSessionHolderProcesses(sessionId);
    const holders = processes.map((entry) => entry.pid);

    if (holders.length > 0) {
        return {
            kind: "busy",
            sessionId,
            holders,
            holderStarts: Object.fromEntries(processes.map((entry) => [entry.pid, entry.startSec * 1000])),
            reason: `Session ${sessionId} is open in Claude Code (pid ${holders.join(", ")}). Exit it first.`,
        };
    }

    if (claudeCodeModePin(sessionPath) === true && (!saved || saved.complete === true)) {
        return {
            kind: "refused",
            reason: `Session ${sessionId} already runs in Code Mode. Resume it with CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1.`,
        };
    }

    const suffix = options.backupSuffix ?? DEFAULT_BACKUP_SUFFIX;
    if (!suffix) {
        return { kind: "refused", reason: "The backup suffix must not be empty." };
    }
    const customTitle = lastClaudeTitleIn(sessionPath);

    if (await copySourceOf(sessionPath, sessionId)) {
        return {
            kind: "refused",
            reason: `Session ${sessionId} is titled "${customTitle}": it is the copy without Code Mode.`,
        };
    }

    const ownTitle = customTitle ?? lastClaudeAiTitleIn(sessionPath);
    const recoveredTitle =
        saved && isJsonObject(saved.plan) && typeof saved.plan.title === "string" ? saved.plan.title : undefined;
    const title = options.title ?? recoveredTitle ?? ownTitle;

    if (!title) {
        return { kind: "refused", reason: `Session ${sessionId} has no title. Pass --title <title>.` };
    }

    const backupId =
        saved && isJsonObject(saved.plan) && typeof saved.plan.backupId === "string"
            ? saved.plan.backupId
            : randomUUID();
    const plan: CodeModeForkPlan = {
        sessionId,
        sessionPath,
        title,
        backupId,
        backupPath: join(dirname(sessionPath), `${backupId}.jsonl`),
        backupTitle:
            saved && isJsonObject(saved.plan) && typeof saved.plan.backupTitle === "string"
                ? saved.plan.backupTitle
                : `${ownTitle ?? title}${suffix}`,
    };

    if (options.dryRun) {
        return { kind: "planned", plan };
    }

    atomicWriteFileSync(statePath, SafeJSON.stringify({ plan, complete: false }), { mode: 0o600 });
    // The copy comes first: when a later step fails, the conversation without Code Mode already exists.
    const backup =
        existsSync(plan.backupPath) && (await copySourceOf(plan.backupPath, backupId)) === sessionId
            ? { rows: 0, droppedPins: 0, droppedTitles: 0, unreadableRows: 0, cwd: null }
            : await writeSessionCopy({
                  sourcePath: sessionPath,
                  sourceId: sessionId,
                  copyId: backupId,
                  copyPath: plan.backupPath,
                  title: plan.backupTitle,
              });
    const pin = (await loadPins({ provider: "claude", readOnly: true })).get(sessionId);
    if (pin) {
        await recordPin({ ...pin, sessionId: backupId, launchId: undefined, at: Date.now(), source: "manual" });
    }
    if (claudeCodeModePin(sessionPath) !== true) {
        appendClaudeCodeModePin(sessionPath, sessionId);
    }

    if (options.title && options.title !== ownTitle) {
        appendClaudeTitle({ path: sessionPath, sessionId, title: options.title });
    }

    atomicWriteFileSync(statePath, SafeJSON.stringify({ plan, complete: true }), { mode: 0o600 });
    return { kind: "forked", plan, backup };
}

const STOP_POLL_MS = 250;

async function waitForExit(pids: readonly number[], timeoutMs: number): Promise<number[]> {
    const deadline = Date.now() + timeoutMs;
    let alive = pids.filter(isProcessAlive);

    while (alive.length > 0 && Date.now() < deadline) {
        await Bun.sleep(Math.min(STOP_POLL_MS, deadline - Date.now()));
        alive = alive.filter(isProcessAlive);
    }

    return alive;
}

/** The shell a person typed the launch into, or what owns the terminal: it and everything above it survive. */
const KEEP_FROM = /^-?(?:\S*\/)?(?:zsh|bash|fish|sh)(?:\s+(?:-l|--login|-i))*\s*$|\blogin\b|cmux|tmux/;

/**
 * A Claude Code process and the launchers above it, up to (not including) the shell of its tab: the GenesisTools
 * launcher, its Bun wrapper and a `zsh -ic exec …` between them. Stopping only Claude Code left the launcher as a
 * stopped job in the tab ("suspended (tty output)", 2026-11-23), because Claude Code runs in its own process group.
 */
function launchChain(pid: number): number[] {
    const chain: number[] = [];

    for (const entry of ancestry(pid)) {
        const command = (entry.command ?? entry.name).trim();
        const launcher = isClaudeLaunchProcess(entry);
        if (entry.pid <= 1 || KEEP_FROM.test(command) || !launcher) {
            break;
        }

        chain.push(entry.pid);
    }

    return chain;
}

/**
 * Stops Claude Code processes: SIGTERM, then SIGKILL for any that still run after `termMs`. Returns the pids that
 * still run after `killMs` more. Claude Code appends every row as it goes, so a stop loses at most the turn in flight.
 */
export async function stopClaudeProcesses(
    pids: readonly number[],
    {
        termMs = 10_000,
        killMs = 5_000,
        expectedStarts,
    }: { termMs?: number; killMs?: number; expectedStarts?: Record<number, number> } = {}
): Promise<number[]> {
    const admitted = expectedStarts
        ? pids.filter((pid) => expectedStarts[pid] !== undefined && readProcess(pid)?.startMs === expectedStarts[pid])
        : pids;
    const members = [...new Set(admitted.flatMap(launchChain))];
    const starts = new Map(members.map((pid) => [pid, readProcess(pid)?.startMs]));
    // The command each member runs as this stop begins. The SIGKILL comes up to termMs later, and a pid that ended and
    // went to another process meanwhile must not get it.
    const commands = new Map(members.map((pid) => [pid, readProcessCommand(pid)]));
    const signal = (target: number, name: NodeJS.Signals) => {
        const command = commands.get(target);

        const started = starts.get(target);
        if (
            !command ||
            started === null ||
            started === undefined ||
            readProcess(target)?.startMs !== started ||
            classifyPid(target, command).status !== "live"
        ) {
            log.debug({ target, signal: name }, "a Claude Code process ended or changed before the signal");
            return;
        }

        try {
            // pid-verified: classifyPid matched the command this pid had when the stop began, read from the live table.
            process.kill(target, name);
        } catch (error) {
            log.debug({ error, target, signal: name }, "a Claude Code process ended before the signal");
        }
    };

    for (const pid of members) {
        signal(pid, "SIGTERM");
    }

    const afterTerm = await waitForExit(members, termMs);

    if (afterTerm.length === 0) {
        log.info({ pids, stopped: members }, "stopped Claude Code and its launchers with SIGTERM");
        return [];
    }

    for (const pid of afterTerm) {
        signal(pid, "SIGKILL");
    }

    const left = await waitForExit(afterTerm, killMs);
    log.warn({ pids, killed: afterTerm, left }, "Claude Code processes needed SIGKILL");
    return left;
}

/** Waits until no Claude Code process has the session open; false when the deadline passed first. */
export async function waitUntilSessionCloses(sessionId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (claudeSessionHolders(sessionId).length > 0) {
        if (Date.now() >= deadline) {
            return false;
        }

        await Bun.sleep(1_000);
    }

    return true;
}

export type CodeModeCheckOutcome =
    | { kind: "refused"; reason: string }
    | { kind: "checked"; sessionId: string; copyId: string; checks: PairCheck[] };

/** The copy of a Code Mode session: titled `<title><suffix>`, and its own `derived-from` row names the session. */
async function findCopy(
    sessionId: string,
    title: string,
    suffix: string
): Promise<{ id: string; path: string } | null> {
    const wanted = `${title}${suffix}`.toLowerCase();
    const hits = findSessionsByTitle(`${title}${suffix}`, { provider: "claude" }).filter(
        (hit) => hit.title.trim().toLowerCase() === wanted
    );

    for (const hit of hits) {
        const path = await canonicalClaudeTranscript(hit.sessionId);

        if (path && (await copySourceOf(path, hit.sessionId)) === sessionId) {
            return { id: hit.sessionId, path };
        }
    }

    return null;
}

/** Checks a session moved into Code Mode against its copy; either id of the pair finds the other. Reads only. */
export async function checkSessionIntoCodeMode(options: {
    session: string;
    backupSuffix?: string;
}): Promise<CodeModeCheckOutcome> {
    const found = await findTranscript(options.session);

    if (typeof found !== "string") {
        return { kind: "refused", reason: found.kind === "refused" ? found.reason : `No session ${options.session}.` };
    }

    const suffix = options.backupSuffix ?? DEFAULT_BACKUP_SUFFIX;
    if (!suffix) {
        return { kind: "refused", reason: "The backup suffix must not be empty." };
    }
    const id = basename(found, ".jsonl");
    const customTitle = lastClaudeTitleIn(found);
    const sourceId = await copySourceOf(found, id);

    if (sourceId) {
        const sessionPath = sourceId ? await canonicalClaudeTranscript(sourceId) : undefined;

        if (!sourceId || !sessionPath) {
            return { kind: "refused", reason: `Copy ${id} names no session it was made from that is still here.` };
        }

        const checks = await checkCodeModePair({
            ids: { sourceId, copyId: id },
            sessionPath,
            copyPath: found,
            suffix,
        });
        return { kind: "checked", sessionId: sourceId, copyId: id, checks };
    }

    const title = customTitle ?? lastClaudeAiTitleIn(found);
    let copy: { id: string; path: string } | null = null;
    for (const name of readdirSync(dirname(found))) {
        if (!name.endsWith(".jsonl")) {
            continue;
        }
        const candidateId = name.slice(0, -6);
        const path = join(dirname(found), name);
        if ((await copySourceOf(path, candidateId)) === id) {
            copy = { id: candidateId, path };
            break;
        }
    }
    copy ??= title ? await findCopy(id, title, suffix) : null;

    if (!copy) {
        return {
            kind: "refused",
            reason: `No copy titled "${title ?? "?"}${suffix}" names session ${id} (sessions written in the last 14 days).`,
        };
    }

    const checks = await checkCodeModePair({
        ids: { sourceId: id, copyId: copy.id },
        sessionPath: found,
        copyPath: copy.path,
        suffix,
    });
    return { kind: "checked", sessionId: id, copyId: copy.id, checks };
}
