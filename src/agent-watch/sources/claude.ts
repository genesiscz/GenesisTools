import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { logger } from "@app/logger";
import { parseJsonl } from "@app/utils/jsonl";
import { classifyAgentState } from "../classify";
import type { AgentEvent, AgentSnapshot } from "../types";

interface ClaudeRecord {
    type?: string;
    timestamp?: string;
    ts?: number | string;
}

export function defaultClaudeRoot(): string {
    return join(homedir(), ".claude", "projects");
}

function recordToEvent(rec: ClaudeRecord): AgentEvent | undefined {
    const raw = rec.timestamp ?? rec.ts;
    const ts = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : Number.NaN;

    if (Number.isNaN(ts)) {
        return undefined;
    }

    // A trailing result/summary record looks like a finish; everything else is output.
    if (rec.type === "result" || rec.type === "summary") {
        return { kind: "exit", ts };
    }

    return { kind: "output", ts };
}

interface ReadClaudeOptions {
    root?: string;
    now: number;
    stallTimeoutMs: number;
}

export async function readClaudeSnapshots(opts: ReadClaudeOptions): Promise<AgentSnapshot[]> {
    const root = opts.root ?? defaultClaudeRoot();

    if (!existsSync(root)) {
        logger.debug({ root }, "claude source root missing; skipping");
        return [];
    }

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
                const buf = readFileSync(path);

                if (buf.length === 0) {
                    continue;
                }

                const records = parseJsonl<ClaudeRecord>(buf);
                const events = records.map(recordToEvent).filter((e): e is AgentEvent => e !== undefined);
                const lastModified = statSync(path).mtimeMs;
                const state = classifyAgentState({
                    events,
                    lastModified,
                    now: opts.now,
                    stallTimeoutMs: opts.stallTimeoutMs,
                });
                const lastOutputAt = events.at(-1)?.ts ?? lastModified;

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
