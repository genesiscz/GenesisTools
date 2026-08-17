/**
 * Shared plumbing for the enrichment crawls: JSONL read/write, a resumable cache,
 * and a polite request pacer.
 *
 * Every enricher is resumable because these crawls take tens of minutes at one request
 * per second. Losing 40 minutes of work to a laptop sleep is the failure mode worth
 * engineering against, so each answered artist is appended to disk immediately.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

const log = logger.child({ component: "spotify:io" });

export function readJsonl<T>(path: string): T[] {
    if (!existsSync(path)) {
        return [];
    }

    return readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => SafeJSON.parse(l, { strict: true }) as T);
}

/**
 * Atomic, because the destination is usually the previous run's harvest or enrichment. A plain
 * write truncates first, so an interruption between truncate and write leaves the dataset gone
 * — and re-harvesting it means another browser session, or another 50-minute crawl.
 */
export function writeJsonl(path: string, rows: unknown[]): void {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${rows.map((r) => SafeJSON.stringify(r)).join("\n")}\n`);
}

export function appendJsonl(path: string, row: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${SafeJSON.stringify(row)}\n`);
}

export function readJson<T>(path: string): T {
    return SafeJSON.parse(readFileSync(path, "utf8")) as T;
}

/** Keys already present in a cache file, so a rerun skips them. */
export function cachedKeys(path: string, key = "uri"): Set<string> {
    const out = new Set<string>();
    for (const row of readJsonl<Record<string, string>>(path)) {
        if (row[key]) {
            out.add(row[key]);
        }
    }

    return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch pacing. `minIntervalMs` is enforced between the START of consecutive calls, so
 * network latency counts toward the pacing instead of being added on top of it — a flat
 * sleep after each response silently halves throughput for no extra politeness.
 */
export class Pacer {
    private next = 0;

    constructor(private minIntervalMs: number) {}

    async wait(): Promise<void> {
        const now = Date.now();
        if (now < this.next) {
            await sleep(this.next - now);
        }

        // Re-read the clock AFTER the sleep. `setTimeout` may resume late under load, and
        // scheduling from the pre-sleep reading would put the next slot earlier than one
        // interval after this call actually started, letting a burst exceed the rate the
        // crawler promised the provider.
        this.next = Math.max(Date.now(), this.next) + this.minIntervalMs;
    }
}

export interface FetchOpts {
    headers?: Record<string, string>;
    tries?: number;
    /** Status codes that mean "this will never work", so stop retrying. */
    fatal?: number[];
    backoffMs?: number;
    /** Per-attempt deadline. A stalled connection otherwise never reaches the retry. */
    timeoutMs?: number;
}

export type FetchResult = { ok: true; body: string } | { ok: false; error: string; status?: number };

const SECRET_PARAM = /key|token|secret|password|signature|sig|auth/i;

function redactParams(params: URLSearchParams): boolean {
    let touched = false;
    for (const name of [...params.keys()]) {
        if (SECRET_PARAM.test(name)) {
            // `set` collapses repeats of one name, which is what we want: every copy of a
            // secret has to go, not just the first.
            params.set(name, "REDACTED");
            touched = true;
        }
    }

    return touched;
}

/**
 * Everything up to and including the LAST "@" goes, keeping only a leading scheme so the line
 * still says what was being fetched. Used where a URL could not be parsed structurally, so no
 * assumption holds about the shape of what precedes the "@" — it may contain slashes, colons
 * or nothing at all.
 */
function stripCredentials(text: string): string {
    const at = text.lastIndexOf("@");
    if (at === -1) {
        return text;
    }

    const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/*/.exec(text)?.[0] ?? "";

    return scheme + text.slice(at + 1);
}

/**
 * A URL as it may be written to the log file. `logger.debug` always reaches the day-stamped
 * file, so a credential carried in the URL (Last.fm puts the API key in the query string) would
 * be persisted in plaintext by the diagnostics below. Redact at the root so every caller of
 * `getText`, present and future, is covered.
 *
 * All three places a URL can carry a secret are handled: the query string, the userinfo before
 * the host (`https://user:password@host`), and the fragment, which is where an OAuth implicit
 * flow leaves an access token.
 */
export function redactUrl(url: string): string {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch (err) {
        // Not a parseable absolute URL, so nothing can be located structurally: no assumption
        // holds about the authority delimiter, and none about what the credential looks like
        // either — it may contain slashes. Fail closed on all three carriers by dropping the
        // query, the fragment, and everything through the last "@". A diagnostic line loses
        // some detail; no credential survives.
        log.debug({ err }, "url did not parse; logging it without credentials, query or fragment");

        return stripCredentials(url.split(/[?#]/)[0] ?? "");
    }

    redactParams(parsed.searchParams);

    if (parsed.username || parsed.password) {
        parsed.username = "";
        parsed.password = "";
    }

    if (parsed.hash.length > 1) {
        const fragment = new URLSearchParams(parsed.hash.slice(1));
        if (redactParams(fragment)) {
            parsed.hash = `#${fragment.toString()}`;
        }
    }

    const serialized = parsed.toString();
    // A hostless URL (`someone:secret@host`) parses as a scheme plus an opaque path, so what
    // looks like userinfo lands in the path, `username`/`password` stay empty, and the path
    // setter is a no-op on such a URL — so scrub the serialized form instead. Scoped to
    // hostless URLs, which leaves an ordinary `https://host/music/@artist` alone.
    return parsed.host ? serialized : stripCredentials(serialized);
}

export async function getText(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
    const { headers = {}, tries = 3, fatal = [404], backoffMs = 1500, timeoutMs = 30_000 } = opts;
    let last = "";
    for (let attempt = 0; attempt < tries; attempt++) {
        try {
            // Every attempt gets a deadline, covering the body read as well as the response.
            // Without one, a connection that opens and then stalls parks here forever and the
            // retry loop below is never reached — during an hour-long enrichment crawl that
            // reads as the tool hanging, with the last progress line still on screen.
            const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
            if (res.ok) {
                return { ok: true, body: await res.text() };
            }

            last = `HTTP ${res.status}`;
            if (fatal.includes(res.status)) {
                log.debug({ url: redactUrl(url), status: res.status }, "fatal status, not retrying");

                return { ok: false, error: last, status: res.status };
            }
        } catch (err) {
            last = String(err);
            log.debug({ url: redactUrl(url), err }, "request threw, will retry");
        }

        if (attempt < tries - 1) {
            await sleep(backoffMs);
        }
    }

    return { ok: false, error: last };
}

export function progress(done: number, total: number, startedAt: number): string {
    const elapsed = (Date.now() - startedAt) / 60000;
    const eta = done ? ((total - done) * elapsed) / done : 0;

    return `[${done}/${total}] ${elapsed.toFixed(1)}m elapsed, ETA ${eta.toFixed(1)}m`;
}
