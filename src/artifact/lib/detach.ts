import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "@genesiscz/utils/string";

/**
 * `serve --detach` used to print the REQUESTED port and return at once. The child moves to the next free port when
 * that one is busy, so on 2026-10-16 an agent handed out http://127.0.0.1:3076/signal-drive while its server listened
 * on 3088, and 3076 was another folder's server: a 404. The parent now waits for the line the child prints once it
 * listens and reports that URL.
 */
export const DETACH_WAIT_MS = 30_000;

/** The URL a serving child prints (`<url> (catalog at / or /__catalog; …)`), or null before it printed it. */
export function servedUrlFromLog(text: string): string | null {
    const match = /(https?:\/\/\S+?:\d+\/\S*)\s+\(catalog at/.exec(stripAnsi(text));
    return match?.[1] ?? null;
}

/** Every launch owns its log, even when several children request the same port. */
export function detachedLogPath(): string {
    return join(mkdtempSync(join(tmpdir(), "artifact-serve-")), "server.log");
}

export type DetachOutcome =
    | { kind: "serving"; url: string; port: number }
    | { kind: "exited"; code: number }
    | { kind: "pending" };

/** Polls the child's log (a cheap read, 250 ms apart) until it names its URL, the child exits, or the deadline passes. */
export async function waitForServedUrl(options: {
    readLog: () => string;
    exitCode: () => number | null;
    timeoutMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}): Promise<DetachOutcome> {
    const now = options.now ?? (() => Date.now());
    const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
    const deadline = now() + (options.timeoutMs ?? DETACH_WAIT_MS);

    while (true) {
        const url = servedUrlFromLog(options.readLog());
        const code = options.exitCode();

        if (code !== null) {
            return { kind: "exited", code };
        }

        if (url) {
            return { kind: "serving", url, port: Number.parseInt(new URL(url).port, 10) };
        }

        const left = deadline - now();

        if (left <= 0) {
            return { kind: "pending" };
        }

        await sleep(Math.min(250, left));
    }
}
