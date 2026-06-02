import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { parseJsonl } from "@app/utils/jsonl";
import { isProcessAlive } from "@app/utils/process-alive";
import { classifyAgentState } from "../classify";
import type { AgentEvent, AgentSnapshot } from "../types";

interface TaskLine {
    type: "meta" | "line" | "exit";
    ts?: number | string;
    text?: string;
    code?: number;
}

interface TaskMeta {
    pid?: number;
    exitCode?: number;
    lastActivityAt?: number;
}

export function defaultTaskDir(): string {
    return join(homedir(), ".genesis-tools", "task", "sessions");
}

function toEpochMs(ts: number | string | undefined): number | undefined {
    if (typeof ts === "number") {
        return ts;
    }

    if (typeof ts === "string") {
        const parsed = Date.parse(ts);
        return Number.isNaN(parsed) ? undefined : parsed;
    }

    return undefined;
}

function lineToEvent(line: TaskLine): AgentEvent | undefined {
    const ts = toEpochMs(line.ts);

    if (line.type === "exit") {
        return { kind: "exit", ts: ts ?? 0, exitCode: line.code };
    }

    if (line.type === "line" && ts !== undefined) {
        return { kind: "output", ts, text: line.text };
    }

    return undefined;
}

interface ReadTaskOptions {
    dir?: string;
    now: number;
    stallTimeoutMs: number;
}

export async function readTaskSnapshots(opts: ReadTaskOptions): Promise<AgentSnapshot[]> {
    const dir = opts.dir ?? defaultTaskDir();

    if (!existsSync(dir)) {
        logger.debug({ dir }, "task source dir missing; skipping");
        return [];
    }

    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".ui.jsonl"));
    const snapshots: AgentSnapshot[] = [];

    for (const file of files) {
        const path = join(dir, file);
        const name = basename(file, ".jsonl");

        try {
            const buf = readFileSync(path);
            const records = parseJsonl<TaskLine>(buf);
            const events = records.map(lineToEvent).filter((e): e is AgentEvent => e !== undefined);

            const metaPath = join(dir, `${name}.meta.json`);
            let pidAlive: boolean | undefined;
            let metaExitCode: number | undefined;

            if (existsSync(metaPath)) {
                const meta = SafeJSON.parse(readFileSync(metaPath, "utf8")) as TaskMeta;
                metaExitCode = meta.exitCode;

                if (typeof meta.pid === "number" && meta.exitCode === undefined) {
                    pidAlive = isProcessAlive(meta.pid);
                }
            }

            const lastModified = statSync(path).mtimeMs;
            const state = classifyAgentState({
                events,
                lastModified,
                now: opts.now,
                stallTimeoutMs: opts.stallTimeoutMs,
                pidAlive,
            });

            const lastEvent = events.at(-1);
            const exitEvent = events.find((e) => e.kind === "exit");
            const lastOutputAt = lastEvent?.ts ?? lastModified;
            const lastLine = [...events].reverse().find((e) => e.text)?.text;

            snapshots.push({
                id: `task:${name}`,
                name,
                source: "task",
                state,
                lastOutputAt,
                ageMs: opts.now - lastOutputAt,
                exitCode: exitEvent?.exitCode ?? metaExitCode,
                lastLine,
            });
        } catch (err) {
            logger.warn({ err, path }, "failed to read task session; skipping");
        }
    }

    return snapshots;
}
