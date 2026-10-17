import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { formatStoredEventLine, type StoredCodexEvent } from "./adapter";
import { sessionEventsPath } from "./paths";
import { CodexSessionStore } from "./store";

/**
 * A size snapshot can land in the middle of a record the session is still
 * appending. Only whole lines are handed on; the tail after the last newline
 * waits for the next read, so a record split across two reads is parsed once
 * instead of being dropped as two invalid fragments.
 */
export function takeCompleteLines(buffer: string): { complete: string; rest: string } {
    const cut = buffer.lastIndexOf("\n");
    if (cut === -1) {
        return { complete: "", rest: buffer };
    }

    return { complete: buffer.slice(0, cut + 1), rest: buffer.slice(cut + 1) };
}

/**
 * Codex's app-server names a turn by id, not by number, so a rendered turn line read "▶ turn ? started". The
 * follower counts the turns it renders (seeded from the log it skipped) and numbers the start and end lines.
 */
export interface TurnCounter {
    n: number;
}

export function numberTurnLine(line: string, turns: TurnCounter): string {
    if (line.startsWith("▶ turn ? ")) {
        turns.n += 1;
        return line.replace("turn ?", `turn ${turns.n}`);
    }

    if (line.startsWith("✔ turn ? ") && turns.n > 0) {
        return line.replace("turn ?", `turn ${turns.n}`);
    }

    return line;
}

function isTurnStartLine(rawLine: string): boolean {
    if (!rawLine.trim()) {
        return false;
    }

    try {
        const event = SafeJSON.parse(rawLine, { strict: true }) as StoredCodexEvent | null;
        return event?.method === "turn/started";
    } catch (err) {
        logger.debug({ err, rawLine: rawLine.slice(0, 200) }, "[codex:tail] skipping unparseable event line");
        return false;
    }
}

/** How many turns the skipped part of the log already started, without rendering or retaining output. */
export function countStartedTurns(text: string): number {
    let count = 0;
    let from = 0;
    while (from < text.length) {
        const newline = text.indexOf("\n", from);
        const end = newline === -1 ? text.length : newline;
        if (isTurnStartLine(text.slice(from, end))) {
            count++;
        }
        from = end + 1;
    }
    return count;
}

/** Read only the snapshotted prefix, in 64 KiB blocks, retaining at most one JSONL record. */
async function countHistoricalTurns(path: string, bytes: number): Promise<number> {
    const input = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024, start: 0, end: bytes - 1 });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let failure: Error | undefined;
    input.once("error", (error) => {
        failure = error;
        lines.close();
    });
    let count = 0;
    try {
        for await (const line of lines) {
            if (isTurnStartLine(line)) {
                count++;
            }
        }
        if (failure) {
            throw failure;
        }
        return count;
    } finally {
        lines.close();
        input.destroy();
    }
}

export function printFollowedChunk(text: string, asEvents: boolean, turns: TurnCounter = { n: 0 }): void {
    if (!asEvents) {
        out.print(text);
        return;
    }

    for (const rawLine of text.split("\n")) {
        if (!rawLine.trim()) {
            continue;
        }

        let stored: StoredCodexEvent;
        try {
            stored = SafeJSON.parse(rawLine, { strict: true }) as StoredCodexEvent;
        } catch (err) {
            logger.debug({ err, rawLine: rawLine.slice(0, 200) }, "[codex:tail] skipping unparseable event line");
            continue;
        }

        const line = formatStoredEventLine(stored);
        if (line) {
            out.println(numberTurnLine(line, turns));
        }
    }
}

/**
 * What to read next, given the file size now and where the follower stopped.
 * `undefined` means nothing new.
 *
 * The shrink case is the point: a truncated or rotated events file (the session
 * restarted, the store was rewritten) leaves the old offset past the end, so a
 * bare `size > offset` is false on every later poll and the follower goes silent
 * while still looking alive.
 */
export function planFollowRead(size: number, offset: number): { from: number; rewound: boolean } | undefined {
    if (size < offset) {
        return { from: 0, rewound: true };
    }

    if (size > offset) {
        return { from: offset, rewound: false };
    }

    return undefined;
}

/**
 * Follow a session's raw event log until the session closes.
 *
 * Extracted from the `tail` command body when the worker verbs became shared: the shared
 * `tail` owns `--name` and the lookup, and this is the codex-specific default the driver
 * hands back.
 */
export async function followSessionEvents(name: string, asEvents: boolean): Promise<void> {
    const path = sessionEventsPath(name);
    let offset = existsSync(path) ? statSync(path).size : 0;
    let carry = "";
    const turns: TurnCounter = {
        n: asEvents && offset > 0 ? await countHistoricalTurns(path, offset) : 0,
    };
    // A streaming decoder, not `.text()` per read: a size snapshot can cut
    // a multi-byte codepoint in half, and decoding each byte slice on its
    // own turned every such character into U+FFFD. The decoder holds the
    // incomplete sequence until the next read supplies the rest.
    let decoder = new TextDecoder("utf-8");
    const store = new CodexSessionStore();

    for (;;) {
        if (existsSync(path)) {
            const size = statSync(path).size;

            const plan = planFollowRead(size, offset);

            if (plan?.rewound) {
                logger.debug({ path, size, offset }, "[codex:tail] events file shrank, following from 0");
                turns.n = 0;
                carry = "";
                decoder = new TextDecoder("utf-8");
            }

            if (plan) {
                offset = plan.from;
                const bytes = await Bun.file(path).slice(offset, size).arrayBuffer();
                const chunk = decoder.decode(new Uint8Array(bytes), { stream: true });
                const { complete, rest } = takeCompleteLines(carry + chunk);
                carry = rest;
                if (complete) {
                    printFollowedChunk(complete, asEvents, turns);
                }
                offset = size;
            }
        }

        const meta = store.readMeta(name);
        if (!meta || meta.status === "closed" || meta.status === "failed") {
            // A closed session appends nothing more, so an unterminated
            // last line is final and goes out as it is. Flush the decoder
            // first, in case the file ends mid-codepoint.
            const tail = carry + decoder.decode();
            if (tail) {
                printFollowedChunk(tail, asEvents, turns);
            }
            return;
        }

        await Bun.sleep(200);
    }
}
