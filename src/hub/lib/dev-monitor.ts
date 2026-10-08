import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

const log = logger.child({ component: "hub:dev-monitor" });

/**
 * One thing worth an agent's attention while it works on GenesisTools.app: a hang, a long stall, a
 * layout loop, a crash. `tools hub dev monitor` prints one line per event, so the Monitor tool wakes the
 * agent on each instead of the user finding a "not responding" banner first.
 */
export interface DevEvent {
    kind: "wedge" | "hang" | "stall" | "layout-loop" | "slow-main" | "jank" | "error" | "relay" | "crash";
    /** The time the source line carries ("01:46:40.479"), or the file's time for a crash or a hang file. */
    time: string;
    text: string;
    /** A file to read for the details: the hang sample, the stall stacks, the crash report. */
    file?: string;
}

export interface ClassifyOptions {
    /** A recovered stall shorter than this is left out. */
    minStallMs: number;
    /** A SLOW span on the main thread shorter than this is left out. */
    minSlowMainMs: number;
}

export const DEFAULT_CLASSIFY: ClassifyOptions = { minStallMs: 500, minSlowMainMs: 400 };

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

/** Reads what was appended to one text file since the last call, line by line; a rotated file starts over. */
class TextTail {
    private offset: number;
    private partial = "";

    constructor(
        readonly path: string,
        fromStart: boolean
    ) {
        this.offset = fromStart || !existsSync(path) ? 0 : statSync(path).size;
    }

    read(): string[] {
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
    signal: AbortSignal;
    emit: (event: DevEvent) => void;
}

/** The files the monitor reads, for its start line and for tests. */
export function devMonitorSources() {
    return {
        perfLog: genesisToolsDir("logs", "app-perf.log"),
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
    const crashes = new FolderWatch(sources.crashes, (name) => /^Genesis/.test(name) && /\.(ips|crash)$/.test(name));
    // Hang files are announced by their app-perf.log line already; a file with no line means the
    // process could not log any more, which is the case worth a separate event.
    const hangs = new FolderWatch(sources.hangs, (name) => name.startsWith("hang-"));
    const announced = new Set<string>();

    while (!options.signal.aborted) {
        for (const line of perf.read()) {
            const event = classifyPerfLine(line, options);
            if (event) {
                if (event.file) {
                    announced.add(basename(event.file));
                }

                options.emit(event);
            }
        }

        for (const line of relay.read()) {
            const event = classifyRelayLine(line);
            if (event) {
                options.emit(event);
            }
        }

        for (const path of hangs.fresh()) {
            if (!announced.has(basename(path))) {
                options.emit({
                    kind: "hang",
                    time: "",
                    text: "a hang sample was written with no app-perf.log line",
                    file: path,
                });
            }
        }

        for (const path of crashes.fresh()) {
            try {
                options.emit(describeCrash(path, await Bun.file(path).text()));
            } catch (error) {
                log.debug({ path, error }, "dev monitor: crash report not readable yet");
                options.emit({ kind: "crash", time: "", text: `${basename(path)} written`, file: path });
            }
        }

        await Bun.sleep(options.intervalMs);
    }
}
