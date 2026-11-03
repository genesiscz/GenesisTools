import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { watchFileFeed } from "@genesiscz/utils/fs/file-feed-watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { classifyPid, readProcessCommand } from "@genesiscz/utils/process-identity";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";

const { log } = logger.scoped("live-recordings");

export const LIVE_COMMANDS = ["pause", "resume", "stop"] as const;
export type LiveCommand = (typeof LIVE_COMMANDS)[number];
export const LIVE_STATES = ["recording", "paused", "stopping"] as const;
export type LiveState = (typeof LIVE_STATES)[number];

const COMMAND_POLL_MS = 1_000;

export const liveEntrySchema = z.object({
    version: z.literal(1),
    id: z.string().min(1),
    /** `meeting`, `control-session`, or another recorder's own kind. */
    kind: z.string().min(1),
    title: z.string(),
    pid: z.number().int().positive(),
    /** The recorder's command line when it wrote the entry, so a recycled pid reads as gone. */
    pidCommand: z.string().optional(),
    startedAt: z.string(),
    state: z.enum(LIVE_STATES),
    displays: z.array(z.object({ id: z.number(), name: z.string() })).default([]),
    frames: z.number().int().nonnegative().default(0),
    lastFrameAt: z.string().optional(),
    warning: z.string().optional(),
    folder: z.string().optional(),
    controls: z.array(z.enum(LIVE_COMMANDS)).default([...LIVE_COMMANDS]),
});
export type LiveEntry = z.infer<typeof liveEntrySchema>;

export const liveCommandSchema = z.object({ command: z.enum(LIVE_COMMANDS), at: z.string(), from: z.string() });
export type LiveCommandLine = z.infer<typeof liveCommandSchema>;

/** `<genesis-tools root>/recordings/live/`: one `<id>.json` per running recording, and its `<id>.commands.jsonl`. */
export function liveRecordingsDir(): string {
    return genesisToolsDir("recordings", "live");
}

/** A file-name-safe id: `meeting-2026-11-03-1530-planning`. */
export function liveRecordingId(kind: string, key: string): string {
    return `${kind}-${key}`.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
}

function parseOrNull(text: string): unknown {
    try {
        return SafeJSON.parse(text, { strict: true });
    } catch (error) {
        log.debug({ error }, "live recording file is not JSON");
        return null;
    }
}

function entryPaths(dir: string, id: string): { entry: string; commands: string } {
    return { entry: join(dir, `${id}.json`), commands: join(dir, `${id}.commands.jsonl`) };
}

/** False when the entry's process ended or its pid now belongs to another program. */
export function isLiveEntryAlive(entry: LiveEntry): boolean {
    const status = classifyPid(entry.pid, entry.pidCommand).status;
    return status === "live" || status === "unverified";
}

/** The running recordings, for a UI. An entry whose process is gone is left out, never deleted here. */
export function listLiveRecordings(dir = liveRecordingsDir()): LiveEntry[] {
    if (!existsSync(dir)) {
        return [];
    }

    const entries: LiveEntry[] = [];

    for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) {
            continue;
        }

        const parsed = liveEntrySchema.safeParse(parseOrNull(readFileSync(join(dir, name), "utf8")));

        if (!parsed.success) {
            log.debug({ name, issues: parsed.error.issues }, "unreadable live recording entry");
            continue;
        }

        if (isLiveEntryAlive(parsed.data)) {
            entries.push(parsed.data);
        }
    }

    return entries.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function readLiveRecording(id: string, dir = liveRecordingsDir()): LiveEntry | undefined {
    return listLiveRecordings(dir).find((entry) => entry.id === id);
}

/** Asks a running recording to pause, resume or stop. It acts within about a second. */
export function sendLiveCommand(options: { id: string; command: LiveCommand; from: string; dir?: string }): void {
    const dir = options.dir ?? liveRecordingsDir();
    const entry = readLiveRecording(options.id, dir);

    if (!entry) {
        throw new Error(`No running recording "${options.id}"`);
    }

    if (!entry.controls.includes(options.command)) {
        throw new Error(`The recording "${entry.title}" cannot ${options.command}`);
    }

    const line: LiveCommandLine = { command: options.command, at: new Date().toISOString(), from: options.from };
    appendFileSync(entryPaths(dir, options.id).commands, `${SafeJSON.stringify(line)}\n`);
    log.info({ id: options.id, command: options.command, from: options.from }, "live recording command sent");
}

export type LiveEntryChange = Partial<
    Pick<LiveEntry, "title" | "state" | "displays" | "frames" | "lastFrameAt" | "warning">
>;

/**
 * The live entry of one recording that this process runs: written on every change, its commands read through
 * `fs.watch` with a 1 s poll behind it, both files removed by `close()`.
 */
export class LiveRecordingWriter {
    private entry: LiveEntry;
    private readonly paths: { entry: string; commands: string };
    private readonly watching = new AbortController();
    private offset = 0;
    private closed = false;

    constructor(options: {
        id: string;
        kind: string;
        title: string;
        folder?: string;
        displays?: LiveEntry["displays"];
        controls?: LiveCommand[];
        onCommand: (command: LiveCommandLine) => void;
        dir?: string;
    }) {
        const dir = options.dir ?? liveRecordingsDir();
        mkdirSync(dir, { recursive: true });
        this.paths = entryPaths(dir, options.id);
        const pidCommand = readProcessCommand(process.pid);
        this.entry = {
            version: 1,
            id: options.id,
            kind: options.kind,
            title: options.title,
            pid: process.pid,
            ...(pidCommand ? { pidCommand } : {}),
            startedAt: new Date().toISOString(),
            state: "recording",
            displays: options.displays ?? [],
            frames: 0,
            ...(options.folder ? { folder: options.folder } : {}),
            controls: options.controls ?? [...LIVE_COMMANDS],
        };
        // Commands written for an earlier recording with the same id are not this one's.
        atomicWriteFileSync(this.paths.commands, "");
        this.write();
        void watchFileFeed({
            path: this.paths.commands,
            pollFallbackMs: COMMAND_POLL_MS,
            signal: this.watching.signal,
            onChange: () => this.readCommands(options.onCommand),
        });
        log.info({ id: options.id, kind: options.kind }, "live recording entry written");
    }

    get id(): string {
        return this.entry.id;
    }

    get current(): LiveEntry {
        return { ...this.entry };
    }

    update(change: LiveEntryChange): void {
        if (this.closed) {
            return;
        }

        this.entry = { ...this.entry, ...change };

        if ("warning" in change && change.warning === undefined) {
            delete this.entry.warning;
        }

        this.write();
    }

    /** Removes both files; the recording is no longer live. */
    close(): void {
        if (this.closed) {
            return;
        }

        this.closed = true;
        this.watching.abort();

        for (const path of [this.paths.entry, this.paths.commands]) {
            if (existsSync(path)) {
                unlinkSync(path);
            }
        }

        log.info({ id: this.entry.id }, "live recording entry removed");
    }

    [Symbol.dispose](): void {
        this.close();
    }

    private write(): void {
        atomicWriteFileSync(this.paths.entry, SafeJSON.stringify(this.entry, null, 2));
    }

    private readCommands(onCommand: (command: LiveCommandLine) => void): void {
        if (this.closed || !existsSync(this.paths.commands) || statSync(this.paths.commands).size <= this.offset) {
            return;
        }

        const bytes = readFileSync(this.paths.commands);
        const end = bytes.lastIndexOf(0x0a) + 1;

        if (end <= this.offset) {
            return;
        }

        const text = bytes.subarray(this.offset, end).toString("utf8");
        this.offset = end;

        for (const row of text.split("\n")) {
            if (!row.trim()) {
                continue;
            }

            const parsed = liveCommandSchema.safeParse(parseOrNull(row));

            if (!parsed.success) {
                log.warn({ row, id: this.entry.id }, "unreadable live recording command");
                continue;
            }

            log.info({ id: this.entry.id, command: parsed.data }, "live recording command received");
            onCommand(parsed.data);
        }
    }
}
