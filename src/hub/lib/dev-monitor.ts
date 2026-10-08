import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { formatLocalDate } from "@genesiscz/utils/date";
import { logger } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

const log = logger.child({ component: "hub:dev-monitor" });

/**
 * One thing worth an agent's attention while it works on GenesisTools.app: a hang, a long stall, a
 * layout loop, a crash. `tools hub dev monitor` prints one line per event, so the Monitor tool wakes the
 * agent on each instead of the user finding a "not responding" banner first.
 */
export interface DevEvent {
    kind: "wedge" | "hang" | "stall" | "layout-loop" | "slow-main" | "jank" | "error" | "relay" | "crash" | "slow";
    /** The time the source line carries ("01:46:40.479"), or the file's time for a crash or a hang file. */
    time: string;
    text: string;
    /** A file to read for the details: the hang sample, the stall stacks, the crash report. */
    file?: string;
    /** Events with one key inside a batch print as one line with a count (a timer that is slow every call). */
    key?: string;
    /** The duration, for the "max" of a collapsed line. */
    ms?: number;
}

export interface ClassifyOptions {
    /** A recovered stall shorter than this is left out. */
    minStallMs: number;
    /** A profiling line (`tools config profiling`) shorter than this is left out. */
    minProfileMs: number;
    /** A SLOW span on the main thread shorter than this is left out. */
    minSlowMainMs: number;
}

export const DEFAULT_CLASSIFY: ClassifyOptions = { minStallMs: 500, minSlowMainMs: 400, minProfileMs: 1000 };

const profilePattern = /^\[profile:([^\]]+)\] (.*?) (\d+(?:\.\d+)?)(ms|s)(?: trace=(\S+))?(?: pid=(\d+))?$/;

/**
 * A line of the day's profiling log as an event when it took at least `minProfileMs`: a timer inside a
 * `tools` command, or the `cli` line of a whole command run. Summary rows and `@` marks are not durations.
 */
export function classifyProfileLine(line: string, options: ClassifyOptions = DEFAULT_CLASSIFY): DevEvent | null {
    const match = line.match(profilePattern);

    if (!match || match[2].startsWith("@") || /^\s|── /.test(match[2])) {
        return null;
    }

    const ms = Number(match[3]) * (match[4] === "s" ? 1000 : 1);
    // A whole command run counts by its CPU, unless the app waits on it: a server or a watcher started from
    // a shell lives for minutes and costs little, and its wall time says nothing.
    const cpu = Number(match[2].match(/\bcpu=(\d+)ms\b/)?.[1] ?? Number.NaN);
    const appWaits = /\bcaller=app\b/.test(match[2]);
    const cost = match[1] === "cli" && Number.isFinite(cpu) && !appWaits ? cpu : ms;

    if (cost < options.minProfileMs) {
        return null;
    }

    const [, scope, label, , , trace, pid] = match;
    const duration = ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
    const who = pid ? ` [${processName(Number(pid))}]` : "";
    return {
        kind: "slow",
        time: "",
        text: `${scope} ${label} ${duration}${trace ? ` trace=${trace}` : ""}${who}`.slice(0, 300),
        key: `${scope} ${label.replace(/\d+/g, "N")}${who}`,
        ms,
    };
}

const processNames = new Map<number, string>();

/** `pid 123 hub serve`: the process's tool and verbs, looked up once per pid (gone: the pid alone). */
function processName(pid: number): string {
    const known = processNames.get(pid);

    if (known) {
        return known;
    }

    const command = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)])
        .stdout.toString()
        .trim();
    const name = command ? `pid ${pid} ${shortCommand(command)}` : `pid ${pid}`;
    processNames.set(pid, name);
    return name;
}

/** `bun …/src/hub/index.ts serve --x` and `gt-hub --preload … serve` both read `hub serve`. */
export function shortCommand(command: string): string {
    const words = command.split(/\s+/).filter((word) => !word.startsWith("--preload"));
    const entry = words.findIndex((word) => /\/src\/[^/]+\/index\.tsx?$/.test(word) || /\/tools$/.test(word));

    if (entry === -1) {
        return command.split("/").pop()?.slice(0, 60) ?? command.slice(0, 60);
    }

    const tool = words[entry].match(/\/src\/([^/]+)\/index\.tsx?$/)?.[1];
    const rest = words.slice(entry + 1);
    const firstOption = rest.findIndex((word) => word.startsWith("-"));
    const verbs = (firstOption === -1 ? rest : rest.slice(0, firstOption))
        .filter((word) => !word.includes("/"))
        .slice(0, 3);
    return [tool, ...verbs].filter(Boolean).join(" ");
}

const timePattern = /^\[(\d\d:\d\d:\d\d(?:\.\d+)?)\]\s*/;

/** An app-perf.log line as an event, or null for the routine ones (spans, marks, quick stalls). */
export function classifyPerfLine(line: string, options: ClassifyOptions = DEFAULT_CLASSIFY): DevEvent | null {
    const time = line.match(timePattern)?.[1] ?? "";
    const body = line.replace(timePattern, "").replace(/^mark\s+/, "");
    const short = (text: string) => text.replace(/ recent=\[.*$/, "").slice(0, 300);

    if (/WEDGED|main-stall ongoing/.test(body)) {
        return { kind: "wedge", time, text: short(body) };
    }

    const sampled = body.match(/main-stall .*sampling to (\S+)/);
    if (sampled) {
        return { kind: "hang", time, text: short(body), file: genesisToolsDir("logs", "hangs", sampled[1]) };
    }

    const stacks = body.match(/main-stall stacks .*→ (\S+)/);
    if (stacks) {
        return { kind: "hang", time, text: short(body), file: genesisToolsDir("logs", "hangs", stacks[1]) };
    }

    const recovered = body.match(/main-stall recovered after (\d+)ms/);
    if (recovered) {
        return Number(recovered[1]) >= options.minStallMs ? { kind: "stall", time, text: short(body) } : null;
    }

    if (body.includes("layout.loop")) {
        return { kind: "layout-loop", time, text: short(body) };
    }

    const slowMain = body.match(/SLOW ([\d.]+)ms main\b/) ?? body.match(/main busy ([\d.]+) ms/);
    if (slowMain) {
        return Number(slowMain[1]) >= options.minSlowMainMs ? { kind: "slow-main", time, text: short(body) } : null;
    }

    const frames = body.match(/^frames \d+ dropped .* worst (\d+)ms/);
    if (frames) {
        return Number(frames[1]) >= options.minStallMs ? { kind: "jank", time, text: short(body) } : null;
    }

    if (/\b(failed|error|Error|crash)\b/.test(body) && !/\b0 failed\b/.test(body)) {
        return { kind: "error", time, text: short(body) };
    }

    return null;
}

/** A link-relay.log line as an event: only what says the relay is not doing its job. */
export function classifyRelayLine(line: string): DevEvent | null {
    if (!/FAILED|without a clean exit|older than the running relay|no relay runs|not running after/.test(line)) {
        return null;
    }

    const time = line.match(/T(\d\d:\d\d:\d\d)/)?.[1] ?? "";
    return { kind: "relay", time, text: line.replace(/^\S+\s+/, "").slice(0, 300) };
}

/** The app and the exception of a macOS crash report (`.ips`): its first line is JSON, the rest a JSON body. */
export function describeCrash(path: string, text: string): DevEvent {
    const app = text.match(/"app_name"\s*:\s*"([^"]+)"/)?.[1] ?? basename(path).split("-")[0];
    const type = text.match(/"exception"\s*:\s*\{[^}]*"type"\s*:\s*"([^"]+)"/)?.[1];
    const signal = text.match(/"exception"\s*:\s*\{[^}]*"signal"\s*:\s*"([^"]+)"/)?.[1];
    const reason = text.match(/"termination"\s*:\s*\{[^}]*"indicator"\s*:\s*"([^"]+)"/)?.[1];
    const parts = [type, signal, reason].filter(Boolean).join(" ");
    return { kind: "crash", time: "", text: `${app} crashed${parts ? `: ${parts}` : ""}`, file: path };
}

export function formatEvent(event: DevEvent): string {
    return `[${event.time || new Date().toTimeString().slice(0, 8)}] ${event.kind} ${event.text}${event.file ? ` (${event.file})` : ""}`;
}

/**
 * Reads what was appended to one text file since the last call, line by line; a rotated file starts over.
 * A path function follows a day-stamped log to the next day's file, from its start.
 */
class TextTail {
    private offset: number;
    private partial = "";
    private path: string;

    constructor(
        private readonly pathOf: string | (() => string),
        fromStart: boolean
    ) {
        this.path = this.current();
        this.offset = fromStart || !existsSync(this.path) ? 0 : statSync(this.path).size;
    }

    private current(): string {
        return typeof this.pathOf === "string" ? this.pathOf : this.pathOf();
    }

    read(): string[] {
        const now = this.current();

        if (now !== this.path) {
            this.path = now;
            this.offset = 0;
            this.partial = "";
        }

        if (!existsSync(this.path)) {
            return [];
        }

        const fd = openSync(this.path, "r");
        try {
            const size = fstatSync(fd).size;
            if (size < this.offset) {
                this.offset = 0;
                this.partial = "";
            }

            if (size === this.offset) {
                return [];
            }

            const buffer = Buffer.alloc(size - this.offset);
            readSync(fd, buffer, 0, buffer.length, this.offset);
            this.offset = size;
            const text = this.partial + buffer.toString("utf8");
            const lines = text.split("\n");
            this.partial = lines.pop() ?? "";
            return lines.filter((line) => line.length > 0);
        } finally {
            closeSync(fd);
        }
    }
}

/** New files in a folder whose name passes `accept`, by name; the ones there at the start are not news. */
class FolderWatch {
    private seen: Set<string>;

    constructor(
        readonly dir: string,
        private readonly accept: (name: string) => boolean
    ) {
        this.seen = new Set(this.list());
    }

    private list(): string[] {
        if (!existsSync(this.dir)) {
            return [];
        }

        try {
            return readdirSync(this.dir).filter(this.accept);
        } catch (error) {
            log.debug({ dir: this.dir, error }, "dev monitor: folder not readable");
            return [];
        }
    }

    fresh(): string[] {
        const now = this.list().filter((name) => !this.seen.has(name));
        for (const name of now) {
            this.seen.add(name);
        }

        return now.map((name) => join(this.dir, name));
    }
}

export interface DevMonitorOptions extends ClassifyOptions {
    /** Replay what the logs already hold instead of starting at their end. */
    fromStart: boolean;
    /** How often the files are read. */
    intervalMs: number;
    /**
     * At most one batch per this many ms: events wait and go out together, so an agent running this under
     * the Monitor tool is woken once per batch, not once per line (Martin, 2026-10-08: default 10 s).
     * The first event after a quiet stretch goes out at once.
     */
    minDelayMs: number;
    signal: AbortSignal;
    emit: (events: DevEvent[]) => void;
}

/** Holds events until `minDelayMs` has passed since the last batch went out. */
export class EventBatcher {
    private pending: DevEvent[] = [];
    private lastFlush = Number.NEGATIVE_INFINITY;

    constructor(
        private readonly minDelayMs: number,
        private readonly emit: (events: DevEvent[]) => void
    ) {}

    add(event: DevEvent): void {
        this.pending.push(event);
    }

    /** Sends what waits when the delay has passed; returns how many went out. */
    flush(now: number): number {
        if (this.pending.length === 0 || now - this.lastFlush < this.minDelayMs) {
            return 0;
        }

        const batch = this.pending;
        this.pending = [];
        this.lastFlush = now;
        this.emit(collapse(batch));
        return batch.length;
    }
}

/** Events with one key become the first of them plus "×N, max …", in the place of the first. */
export function collapse(events: DevEvent[]): DevEvent[] {
    const groups = new Map<string, DevEvent[]>();
    const result: DevEvent[] = [];

    for (const event of events) {
        if (!event.key) {
            result.push(event);
            continue;
        }

        const group = groups.get(event.key);

        if (group) {
            group.push(event);
            continue;
        }

        const fresh = [event];
        groups.set(event.key, fresh);
        result.push(event);
    }

    return result.map((event) => {
        const group = event.key ? groups.get(event.key) : undefined;

        if (!group || group.length === 1) {
            return event;
        }

        const max = Math.max(...group.map((item) => item.ms ?? 0));
        return { ...event, text: `${event.text} (×${group.length}, max ${(max / 1000).toFixed(2)}s)` };
    });
}

/** The files the monitor reads, for its start line and for tests. */
export function devMonitorSources() {
    return {
        perfLog: genesisToolsDir("logs", "app-perf.log"),
        profileLog: () => genesisToolsDir("logs", `${formatLocalDate(new Date())}-profiling.log`),
        relayLog: genesisToolsDir("app", "link-relay.log"),
        hangs: genesisToolsDir("logs", "hangs"),
        crashes: join(homedir(), "Library", "Logs", "DiagnosticReports"),
    };
}

/** Runs until `signal` aborts. Reads by interval: app-perf.log is written by several processes at once. */
export async function runDevMonitor(options: DevMonitorOptions): Promise<void> {
    const sources = devMonitorSources();
    const perf = new TextTail(sources.perfLog, options.fromStart);
    const relay = new TextTail(sources.relayLog, options.fromStart);
    const profile = new TextTail(sources.profileLog, options.fromStart);
    const crashes = new FolderWatch(sources.crashes, (name) => /^Genesis/.test(name) && /\.(ips|crash)$/.test(name));
    // Hang files are announced by their app-perf.log line already; a file with no line means the
    // process could not log any more, which is the case worth a separate event.
    const hangs = new FolderWatch(sources.hangs, (name) => name.startsWith("hang-"));
    const announced = new Set<string>();
    const batcher = new EventBatcher(options.minDelayMs, options.emit);

    while (!options.signal.aborted) {
        for (const line of perf.read()) {
            const event = classifyPerfLine(line, options);
            if (event) {
                if (event.file) {
                    announced.add(basename(event.file));
                }

                batcher.add(event);
            }
        }

        for (const line of profile.read()) {
            const event = classifyProfileLine(line, options);
            if (event) {
                batcher.add({ ...event, time: new Date().toTimeString().slice(0, 8) });
            }
        }

        for (const line of relay.read()) {
            const event = classifyRelayLine(line);
            if (event) {
                batcher.add(event);
            }
        }

        for (const path of hangs.fresh()) {
            if (!announced.has(basename(path))) {
                batcher.add({
                    kind: "hang",
                    time: "",
                    text: "a hang sample was written with no app-perf.log line",
                    file: path,
                });
            }
        }

        for (const path of crashes.fresh()) {
            try {
                batcher.add(describeCrash(path, await Bun.file(path).text()));
            } catch (error) {
                log.debug({ path, error }, "dev monitor: crash report not readable yet");
                batcher.add({ kind: "crash", time: "", text: `${basename(path)} written`, file: path });
            }
        }

        batcher.flush(Date.now());
        try {
            await delay(options.intervalMs, undefined, { signal: options.signal });
        } catch (error) {
            if (!options.signal.aborted) {
                throw error;
            }
        }
    }
}
