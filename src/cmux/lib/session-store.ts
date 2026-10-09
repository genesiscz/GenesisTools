import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { LockTimeoutError, withFileLock } from "@genesiscz/utils/storage/file-lock";
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
    /**
     * The cmux UUIDs of `workspace` and `surface`. Refs renumber after a cmux restart and these do not, so
     * `close` acts on the refs only while the UUIDs still match. Lines written before they were stored lack them.
     */
    workspaceId?: string | null;
    surfaceId?: string | null;
    tmuxSession: string | null;
    /** The tmux pane (`%41`) the agent runs in; the exit command targets it. Absent on older lines. */
    tmuxPane?: string | null;
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
    /**
     * The `createdAt` of the created line this closes. A late close of an earlier session with the same name then
     * cannot close a newer one. Lines written before it was stored close whatever is open under the name.
     */
    createdAt?: string;
    closedAt: string;
    outcome: "closed" | "partial";
    steps: Record<string, boolean>;
}

export type SessionRecordLine = SessionCreatedRecord | SessionClosedRecord;

export interface SessionStore {
    read(): SessionRecordLine[];
    append(line: SessionRecordLine): void;
    pidFile(name: string): string;
    /**
     * Run `fn` while this process alone holds the session name, across processes. `agents new` checks the name,
     * opens the workspace and appends the record inside it, so two starts with one --name cannot both pass the
     * check and share a pid file. Throws SessionNameBusyError when another live process holds the name.
     */
    reserve<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export class SessionNameBusyError extends Error {
    constructor(name: string) {
        super(
            `a session named "${name}" is being started or closed by another ${toolCommand("cmux agents")} command; wait for it, or pass another --name`
        );
        this.name = "SessionNameBusyError";
    }
}

/** The holder starts a workspace (and maybe tmux) before it lets go, so a second start fails fast instead of queueing. */
const NAME_LOCK_WAIT_MS = 1_000;

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
        async reserve(name, fn) {
            const dir = join(dirname(path), "sessions");
            mkdirSync(dir, { recursive: true });

            try {
                return await withFileLock(join(dir, `${name}.lock`), fn, NAME_LOCK_WAIT_MS);
            } catch (error) {
                if (error instanceof LockTimeoutError) {
                    throw new SessionNameBusyError(name);
                }

                throw error;
            }
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
        } else if (!line.createdAt || open.get(line.name)?.createdAt === line.createdAt) {
            open.delete(line.name);
        }
    }

    return [...open.values()];
}
