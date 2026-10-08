import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import type { SessionAgentId } from "./session-agents";

const { log } = logger.scoped("cmux-session");

/** One line per session `tools cmux agents new` opened. `close` adopts other agent sessions through cmux-refs. */
export interface SessionCreatedRecord {
    type: "created";
    name: string;
    agent: SessionAgentId;
    account: string;
    model: string | null;
    cwd: string;
    window: string;
    workspace: string;
    surface: string;
    tmuxSession: string | null;
    /** The shell that runs the agent writes its pid here. */
    pidFile: string;
    command: string;
    createdAt: string;
    /** `session-agent-new` on lines written before the command moved to `tools cmux agents new`. */
    createdBy: "agents-new" | "session-agent-new";
}

export interface SessionClosedRecord {
    type: "closed";
    name: string;
    closedAt: string;
    outcome: "closed" | "partial";
    steps: Record<string, boolean>;
}

export type SessionRecordLine = SessionCreatedRecord | SessionClosedRecord;

export interface SessionStore {
    read(): SessionRecordLine[];
    append(line: SessionRecordLine): void;
    pidFile(name: string): string;
}

export function fileSessionStore(path: string = toolDataDir("cmux", "sessions.jsonl")): SessionStore {
    return {
        read() {
            if (!existsSync(path)) {
                return [];
            }

            const lines: SessionRecordLine[] = [];

            for (const raw of readFileSync(path, "utf8").split("\n")) {
                if (!raw.trim()) {
                    continue;
                }

                try {
                    const parsed: unknown = SafeJSON.parse(raw, { strict: true });

                    if (isRecordLine(parsed)) {
                        lines.push(parsed);
                    }
                } catch (error) {
                    log.debug({ error, path }, "skipping an unreadable sessions.jsonl line");
                }
            }

            return lines;
        },
        append(line) {
            mkdirSync(dirname(path), { recursive: true });
            appendFileSync(path, `${SafeJSON.stringify(line, { strict: true })}\n`);
        },
        pidFile(name) {
            const dir = join(dirname(path), "sessions");
            mkdirSync(dir, { recursive: true });
            return join(dir, `${name}.pid`);
        },
    };
}

function isRecordLine(value: unknown): value is SessionRecordLine {
    if (typeof value !== "object" || value === null || !("type" in value) || !("name" in value)) {
        return false;
    }

    return (value.type === "created" || value.type === "closed") && typeof value.name === "string";
}

/** Sessions that were created and not closed since, newest last. */
export function openSessions(lines: readonly SessionRecordLine[]): SessionCreatedRecord[] {
    const open = new Map<string, SessionCreatedRecord>();

    for (const line of lines) {
        if (line.type === "created") {
            open.set(line.name, line);
        } else {
            open.delete(line.name);
        }
    }

    return [...open.values()];
}
