import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { FileTailer } from "@genesiscz/utils/fs/file-tailer";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { classifyPid } from "@genesiscz/utils/process-identity";

/** The file in a meeting's folder that `listen` appends one event per line to, and `--subscribe-answers` follows. */
export const ANSWER_LOG_FILE = "questions.ndjson";

export type RoundEndReason = "done" | "stopped" | "aborted" | "budget";

export type AnswerEvent =
    | { event: "round-start"; at: string; pid: number; open: number }
    | {
          event: "answered";
          at: string;
          item: string;
          about: string;
          fromSec: number;
          toSec: number;
          question: string;
          heard?: string;
          answer: string;
          comment?: string;
          /** Other questions the same answer settled. */
          settled: string[];
      }
    | { event: "skipped"; at: string; item: string }
    | { event: "split"; at: string; item: string; into: number }
    /** The listener went back: the item's answer is undone and it is asked again; `also`: the look-alikes it had settled. */
    | { event: "reopened"; at: string; item: string; also?: string[] }
    /** `open` is -1 when the subscriber reports a listener that ended without writing its round-end. */
    | { event: "round-end"; at: string; reason: RoundEndReason; asked: number; open: number };

export function appendAnswerEvent(path: string, event: AnswerEvent): void {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${SafeJSON.stringify(event, { jsonl: true })}\n`);
}

function isAnswerEvent(value: unknown): value is AnswerEvent {
    return typeof value === "object" && value !== null && typeof (value as { event?: unknown }).event === "string";
}

export function readAnswerEvents(path: string): AnswerEvent[] {
    if (!existsSync(path)) {
        return [];
    }

    return Array.from(readLinesSync(path))
        .filter((line) => line.trim())
        .map((line) => SafeJSON.parse(line, { jsonl: true }))
        .filter(isAnswerEvent);
}

/** The events of the round still running (a round-start with no round-end after it), or none. */
export function runningRound(events: AnswerEvent[]): AnswerEvent[] {
    for (let n = events.length - 1; n >= 0; n -= 1) {
        const event = events[n]!;

        if (event.event === "round-end") {
            return [];
        }

        if (event.event === "round-start") {
            return events.slice(n);
        }
    }

    return [];
}

/** The pid a round recorded still runs `meetings listen`: a recycled pid is no listener. */
function listenerAlive(pid: number): boolean {
    const { status } = classifyPid(pid, (command) => /\bmeetings\b/.test(command) && /\blisten\b/.test(command));
    return status === "live" || status === "unverified";
}

/** A round is running in this log: its round-start has no round-end yet and its listener still runs. */
export function roundRunning(path: string, alive: (pid: number) => boolean = listenerAlive): boolean {
    const start = runningRound(readAnswerEvents(path))[0];
    return start?.event === "round-start" && alive(start.pid);
}

/**
 * Prints each answer event as one JSON line while a person answers in `listen`, and resolves with the exit code:
 * 0 when a round ends (an aborted round-end when the listening process is gone without writing one), 2 on the
 * timeout. It first prints the round that is already running (`fromStart`: the whole file), so no answer is missed.
 */
export async function subscribeAnswers(options: {
    path: string;
    fromStart: boolean;
    timeoutMs: number;
    write: (line: string) => void;
    alive?: (pid: number) => boolean;
    livenessMs?: number;
}): Promise<number> {
    const alive = options.alive ?? listenerAlive;
    const backlog = readAnswerEvents(options.path);
    const running = runningRound(backlog);
    let roundPid = running[0]?.event === "round-start" ? running[0].pid : undefined;
    let asked = 0;

    const track = (event: AnswerEvent): void => {
        options.write(SafeJSON.stringify(event, { jsonl: true }));

        if (event.event === "round-start") {
            roundPid = event.pid;
            asked = 0;
        } else if (event.event === "answered" || event.event === "skipped") {
            asked += 1;
        } else if (event.event === "reopened") {
            asked = Math.max(0, asked - 1);
        }
    };

    for (const event of options.fromStart ? backlog : running) {
        track(event);
    }

    // Counted again from the replayed round only, so a replay of older rounds does not inflate it.
    asked = running.filter((event) => event.event === "answered" || event.event === "skipped").length;

    return await new Promise<number>((resolve) => {
        let done = false;
        const finish = (code: number): void => {
            if (done) {
                return;
            }

            done = true;
            tailer.stop();
            clearInterval(liveness);
            clearTimeout(deadline);
            resolve(code);
        };
        const tailer = new FileTailer<unknown>(
            options.path,
            {
                onLine: (entry) => {
                    if (!isAnswerEvent(entry)) {
                        return;
                    }

                    track(entry);

                    if (entry.event === "round-end") {
                        finish(0);
                    }
                },
            },
            { create: false, from: existsSync(options.path) ? statSync(options.path).size : 0 }
        );
        // A listener killed without its exit handler (a closed terminal) writes no round-end.
        const liveness = setInterval(() => {
            if (roundPid === undefined || alive(roundPid)) {
                return;
            }

            tailer.flush();

            if (!done) {
                track({ event: "round-end", at: new Date().toISOString(), reason: "aborted", asked, open: -1 });
                finish(0);
            }
        }, options.livenessMs ?? 5000);
        const deadline = setTimeout(() => finish(2), options.timeoutMs);
        tailer.start();
    });
}
