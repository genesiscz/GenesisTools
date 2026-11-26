import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeSessionsDir } from "@genesiscz/utils/claude/peer-message";
import type { PeerProcess } from "@genesiscz/utils/harness/parts";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { classifyCommand } from "@genesiscz/utils/process/classify";
import { listProcesses, type ProcessEntry } from "@genesiscz/utils/process/processes";

const { log } = logger.scoped("agent-context");

/**
 * Claude Code writes `~/.claude/sessions/<pid>.json` for each running process and keeps `sessionId` current. A pid is
 * reused after its process exits, and a stale file can outlive it, so the file counts only when it names this process:
 * its `procStart` (the process start to the second) or, in a file without one, its `startedAt`.
 */
const START_TOLERANCE_SEC = 120;

/** `procStart` has whole seconds and the kernel's start a fraction. */
const PROC_START_TOLERANCE_SEC = 2;

interface ClaudeSessionFile {
    pid?: number;
    sessionId?: string;
    /** When the session began: 1 to 3 s after the process start, minutes after it when many start at once. */
    startedAt?: number;
    /** The process start as `ps -o lstart` prints it in UTC: "Thu Nov  5 15:56:35 2026". */
    procStart?: string;
}

/** The seconds since the epoch of a `procStart` read as UTC, or null when it is missing or does not parse. */
function procStartSec(value: unknown): number | null {
    if (typeof value !== "string" || value.trim() === "") {
        return null;
    }

    const ms = Date.parse(`${value} UTC`);
    return Number.isFinite(ms) ? ms / 1000 : null;
}

/**
 * The file names this process. `procStart` matched the kernel's start to the second in 25 of 25 live sessions
 * (2026-11-05 17:20), while `startedAt` came 167 to 208 s late for 8 sessions started in one burst. The 120 s check
 * on `startedAt` alone refused them, so every decision they posted had the session "unknown".
 */
function sameProcess(file: ClaudeSessionFile, process: PeerProcess): boolean {
    const procStart = procStartSec(file.procStart);

    if (procStart !== null && Math.abs(procStart - process.startSec) <= PROC_START_TOLERANCE_SEC) {
        return true;
    }

    return (
        typeof file.startedAt === "number" && Math.abs(file.startedAt / 1000 - process.startSec) <= START_TOLERANCE_SEC
    );
}

/** The session a running Claude Code process works in, from its session registry; null when no fresh file names it. */
export function claudePeerSession(process: PeerProcess, registryDir: string = claudeSessionsDir()): string | null {
    const path = join(registryDir, `${process.pid}.json`);
    let parsed: ClaudeSessionFile;

    try {
        parsed = SafeJSON.parse(readFileSync(path, "utf8")) as ClaudeSessionFile;
    } catch (error) {
        log.debug({ error, path }, "no readable claude session file for the caller pid");
        return null;
    }

    if (parsed.pid !== process.pid || typeof parsed.sessionId !== "string") {
        return null;
    }

    if (!sameProcess(parsed, process)) {
        log.warn(
            {
                pid: process.pid,
                path,
                startedAt: parsed.startedAt,
                procStart: parsed.procStart,
                startSec: process.startSec,
            },
            "claude session file belongs to an earlier process with this pid"
        );
        return null;
    }

    return parsed.sessionId;
}

/** The native Claude executable and the wrappers this toolkit uses to launch it. */
export function isClaudeLaunchProcess(entry: Pick<ProcessEntry, "name" | "command">): boolean {
    if (!["claude", "gt-claude", "GenesisTools", "bun", "node", "zsh", "bash", "sh"].includes(entry.name)) {
        return false;
    }
    const kind = classifyCommand(entry.command ?? entry.name);
    if (kind.kind === "other" && entry.name === "claude") {
        return true;
    }
    return (kind.kind === "agent" || kind.kind === "wrapper") && kind.provider === "claude" && !kind.service;
}

const REGISTRY_FILE = /^(\d+)\.json$/;

/** A cheap first test before the process lookup; a file removed meanwhile (its process exited) names nothing. */
function registryFileNames(path: string, sessionId: string): boolean {
    try {
        return readFileSync(path, "utf8").includes(sessionId);
    } catch (error) {
        log.debug({ error, path }, "a claude session file went away while the registry was read");
        return false;
    }
}

/**
 * The running Claude Code processes that have this session open now. A registry file counts only when it names the
 * session, its pid runs, and that process is the one the file was written for (`claudePeerSession`), so a stale file
 * of a closed session is not a holder.
 */
export function claudeSessionHolderProcesses(
    sessionId: string,
    {
        registryDir = claudeSessionsDir(),
        processOf,
    }: { registryDir?: string; processOf?: (pid: number) => PeerProcess | null } = {}
): PeerProcess[] {
    let names: string[];

    try {
        names = readdirSync(registryDir);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return [];
        }

        throw error;
    }

    const table = processOf
        ? undefined
        : new Map(listProcesses({ commands: false }).map((entry) => [entry.pid, entry]));
    const lookup =
        processOf ??
        ((pid: number) => {
            const entry = table?.get(pid);
            return entry && !entry.zombie && entry.startMs !== null ? { pid, startSec: entry.startMs / 1000 } : null;
        });
    const holders: PeerProcess[] = [];

    for (const name of names) {
        const pid = REGISTRY_FILE.exec(name)?.[1];

        if (!pid || !registryFileNames(join(registryDir, name), sessionId)) {
            continue;
        }

        const running = lookup(Number(pid));

        if (running && claudePeerSession(running, registryDir) === sessionId) {
            holders.push(running);
        }
    }

    return holders;
}

export function claudeSessionHolders(
    sessionId: string,
    options: { registryDir?: string; processOf?: (pid: number) => PeerProcess | null } = {}
): number[] {
    return claudeSessionHolderProcesses(sessionId, options).map((entry) => entry.pid);
}
