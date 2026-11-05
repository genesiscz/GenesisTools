import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeSessionsDir } from "@genesiscz/utils/claude/peer-message";
import type { PeerProcess } from "@genesiscz/utils/harness/parts";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

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
