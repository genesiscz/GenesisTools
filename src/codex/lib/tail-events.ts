import { existsSync, statSync } from "node:fs";
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

export function printFollowedChunk(text: string, asEvents: boolean): void {
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
            out.println(line);
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
                    printFollowedChunk(complete, asEvents);
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
                printFollowedChunk(tail, asEvents);
            }
            return;
        }

        await Bun.sleep(200);
    }
}
