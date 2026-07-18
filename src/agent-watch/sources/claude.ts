import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseJsonl } from "@genesiscz/utils/jsonl";
import { logger } from "@genesiscz/utils/logger";
import { classifyAgentState } from "../classify";
import type { AgentEvent, AgentSnapshot } from "../types";

interface ClaudeContentBlock {
    type?: string;
    name?: string;
}

interface ClaudeRecord {
    type?: string;
    timestamp?: string;
    ts?: number | string;
    message?: {
        stop_reason?: string | null;
        content?: ClaudeContentBlock[] | string;
    };
}

export function defaultClaudeRoot(): string {
    return join(homedir(), ".claude", "projects");
}

function recordTs(rec: ClaudeRecord): number | undefined {
    const raw = rec.timestamp ?? rec.ts;
    const ts = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    return Number.isNaN(ts) ? undefined : ts;
}

function asksUser(rec: ClaudeRecord): boolean {
    if (rec.type !== "assistant") {
        return false;
    }

    const content = rec.message?.content;
    if (Array.isArray(content) && content.some((b) => b.type === "tool_use" && b.name === "AskUserQuestion")) {
        return true;
    }

    // A completed turn means the session is idle at the prompt, waiting on the user.
    return rec.message?.stop_reason === "end_turn";
}

/**
 * Convert a transcript into normalized events. Only the TRAILING record may
 * mark a finish (`result`) or a question — `summary` records sit at the TOP of
 * compacted/continued sessions and mid-file `result`s belong to subagents, so
 * treating any of them as terminal would freeze live sessions at FINISHED.
 */
function recordsToEvents(records: ClaudeRecord[]): AgentEvent[] {
    const events: AgentEvent[] = [];

    for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        const ts = recordTs(rec);

        if (ts === undefined) {
            continue;
        }

        const isLast = i === records.length - 1;

        if (isLast && rec.type === "result") {
            events.push({ kind: "exit", ts });
        } else if (isLast && asksUser(rec)) {
            events.push({ kind: "question", ts });
        } else {
            events.push({ kind: "output", ts });
        }
    }

    return events;
}

interface ReadClaudeOptions {
    root?: string;
    now: number;
    stallTimeoutMs: number;
    /** Skip files whose mtime is older than this window (ms). 0/undefined = read everything. */
    activeWindowMs?: number;
}

export async function readClaudeSnapshots(opts: ReadClaudeOptions): Promise<AgentSnapshot[]> {
    const root = opts.root ?? defaultClaudeRoot();

    if (!existsSync(root)) {
        logger.debug({ root }, "claude source root missing; skipping");
        return [];
    }

    const cutoffMs = opts.activeWindowMs && opts.activeWindowMs > 0 ? opts.now - opts.activeWindowMs : undefined;
    const snapshots: AgentSnapshot[] = [];
    let projectDirs: import("node:fs").Dirent[] = [];

    try {
        projectDirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch (err) {
        logger.debug({ err, root }, "could not list claude projects root");
        return [];
    }

    for (const projDir of projectDirs) {
        const projPath = join(root, projDir.name);
        let sessionFiles: string[] = [];

        try {
            sessionFiles = readdirSync(projPath).filter((f) => f.endsWith(".jsonl"));
        } catch (err) {
            logger.debug({ err, projPath }, "could not list claude project dir");
            continue;
        }

        for (const file of sessionFiles) {
            const path = join(projPath, file);
            const name = basename(file, ".jsonl");

            try {
                const lastModified = statSync(path).mtimeMs;

                // Pre-read cutoff: don't parse hundreds of stale historical
                // transcripts just to filter them out afterwards. lastOutputAt
                // is always >= mtime, so nothing active is skipped.
                if (cutoffMs !== undefined && lastModified < cutoffMs) {
                    continue;
                }

                const buf = readFileSync(path);

                if (buf.length === 0) {
                    continue;
                }

                const records = parseJsonl<ClaudeRecord>(buf);
                const events = recordsToEvents(records);
                const state = classifyAgentState({
                    events,
                    lastModified,
                    now: opts.now,
                    stallTimeoutMs: opts.stallTimeoutMs,
                });
                // Same effective-activity timestamp the classifier uses —
                // otherwise a live file with an older last parsed event can
                // classify RUNNING yet fall outside the active window.
                const lastOutputAt = Math.max(events.at(-1)?.ts ?? 0, lastModified);

                snapshots.push({
                    id: `claude:${projDir.name}:${name}`,
                    name,
                    source: "claude",
                    state,
                    lastOutputAt,
                    ageMs: opts.now - lastOutputAt,
                });
            } catch (err) {
                logger.warn({ err, path }, "failed to read claude session; skipping");
            }
        }
    }

    return snapshots;
}
