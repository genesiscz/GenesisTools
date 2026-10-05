import { logger } from "@genesiscz/utils/logger";
import { compareText } from "./churn";

export const FSEVENTS_DEVICE = "/dev/fsevents";

/**
 * One process that opened the FSEvents device while fs_usage ran. fs_usage ends a line with the process
 * name and a thread id (`Mail.4821`), never a process id, so the thread ids are all it can say.
 */
export interface FseventsWatcher {
    command: string;
    opens: number;
    threadIds: number[];
}

// Wide fs_usage lines end `<elapsed seconds> [W]  <process name>.<thread id>`. A process name can hold
// spaces ("Google Chrome H"), so the name is everything after the last elapsed-time column.
const AFTER_ELAPSED = /\s\d+\.\d+(?: W)?\s+(\S.*?)\.(\d+)\s*$/;
const LAST_TOKEN = /(\S+?)\.(\d+)\s*$/;

function processOf(line: string): { command: string; threadId: number } | null {
    const match = AFTER_ELAPSED.exec(line) ?? LAST_TOKEN.exec(line);

    if (!match) {
        return null;
    }

    return { command: match[1], threadId: Number.parseInt(match[2], 10) };
}

/** The processes behind the fs_usage lines that name the FSEvents device, busiest first. */
export function parseFsUsageWatchers(lines: Iterable<string>): FseventsWatcher[] {
    const byCommand = new Map<string, { opens: number; threadIds: Set<number> }>();

    for (const line of lines) {
        if (!line.includes(FSEVENTS_DEVICE)) {
            continue;
        }

        const owner = processOf(line);

        if (!owner) {
            logger.debug({ line }, "fsevents: an fs_usage line names the device but ends without a process");
            continue;
        }

        const entry = byCommand.get(owner.command) ?? { opens: 0, threadIds: new Set<number>() };
        entry.opens += 1;
        entry.threadIds.add(owner.threadId);
        byCommand.set(owner.command, entry);
    }

    return [...byCommand.entries()]
        .map(([command, entry]) => ({
            command,
            opens: entry.opens,
            threadIds: [...entry.threadIds].sort((a, b) => a - b),
        }))
        .sort((a, b) => b.opens - a.opens || compareText(a.command, b.command));
}

/** Split a byte stream into lines, holding back a trailing partial line until its newline arrives. */
export async function* streamLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let pending = "";

    for await (const chunk of stream) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";

        yield* lines;
    }

    pending += decoder.decode();

    if (pending !== "") {
        yield pending;
    }
}

export interface WatcherSampleOptions {
    durationMs: number;
    signal?: AbortSignal;
}

/**
 * Run `fs_usage -w` (root only) for the window and list the processes that opened the FSEvents device.
 * It reads fs_usage's output as it arrives and keeps only the matching lines, and it ends fs_usage itself:
 * the old `sh -c "fs_usage | grep"` form killed the shell at the deadline and left fs_usage running.
 */
export async function sampleFseventsWatchers(options: WatcherSampleOptions): Promise<FseventsWatcher[]> {
    const proc = Bun.spawn({ cmd: ["fs_usage", "-w"], stdout: "pipe", stderr: "pipe" });
    logger.debug({ cmd: "fs_usage -w", durationMs: options.durationMs }, "fsevents: sampling fs_usage");
    const stop = () => proc.kill("SIGTERM");
    const deadline = setTimeout(stop, options.durationMs);
    options.signal?.addEventListener("abort", stop, { once: true });

    const matched: string[] = [];

    try {
        for await (const line of streamLines(proc.stdout)) {
            if (line.includes(FSEVENTS_DEVICE)) {
                matched.push(line);
            }
        }
    } finally {
        clearTimeout(deadline);
        options.signal?.removeEventListener("abort", stop);
        proc.kill("SIGTERM");
    }

    const exitCode = await proc.exited;
    const stoppedByUs = proc.signalCode === "SIGTERM";

    if (exitCode !== 0 && !stoppedByUs) {
        const stderr = (await new Response(proc.stderr).text()).trim();
        throw new Error(`fs_usage exited with code ${exitCode}${stderr ? `: ${stderr}` : ""}`);
    }

    logger.debug({ matchedLines: matched.length }, "fsevents: the fs_usage sample finished");

    return parseFsUsageWatchers(matched);
}
