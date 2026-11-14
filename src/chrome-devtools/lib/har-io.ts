/**
 * HAR assembly on top of the capture buffer (retroactive) or a live window.
 * The conversion itself is the chrome-har port in ./har/build.ts.
 */
import { localNetworkBlockOf } from "@genesiscz/utils/chrome-devtools/permissions";
import { sensitiveHeaderKind } from "@genesiscz/utils/http/sensitive-headers";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { attach, type Page } from "./cdp.ts";
import type { RecordedEvent } from "./channels.ts";
import { harFromMessages } from "./har/build.ts";
import type { CdpMessage, HarFile } from "./har/types.ts";
import { captureDir } from "./paths.ts";
import { readEvents } from "./segments.ts";

const { log } = logger.scoped("chrome-devtools:har-io");

/** "90s" | "30m" | "2h" → ms. Bare numbers are minutes. */
export function parseDuration(raw: string): number | null {
    const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i);
    if (!m) {
        return null;
    }

    const n = Number(m[1]);
    const unit = (m[2] ?? "m").toLowerCase();
    const factor = unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;

    return Math.round(n * factor);
}

/** Count Network.loadingFailed events that HAR cannot represent (everything but ERR_ABORTED). */
export function countDroppedFailures(events: { method: string; params: Record<string, unknown> }[]): number {
    return events.filter((e) => e.method === "Network.loadingFailed" && e.params.errorText !== "net::ERR_ABORTED")
        .length;
}

/** Count requests that Local Network Access blocked (the page needs `local-network` / `loopback-network`). */
export function countLocalNetworkBlocks(events: { method: string; params: Record<string, unknown> }[]): number {
    return events.filter((e) => e.method === "Network.loadingFailed" && localNetworkBlockOf(e.params) !== null).length;
}

/**
 * Stitch recorder-captured bodies (Genesis.responseBody events, body channel)
 * onto their responseReceived params so the HAR builder can inline them.
 */
export function stitchBodies(events: RecordedEvent[]): number {
    const bodies = new Map<string, string>();

    for (const ev of events) {
        if (ev.method === "Genesis.responseBody") {
            bodies.set(`${ev.sessionId ?? ""} ${ev.params.requestId}`, String(ev.params.body ?? ""));
        }
    }

    if (bodies.size === 0) {
        return 0;
    }

    let stitched = 0;
    for (const ev of events) {
        if (ev.method !== "Network.responseReceived") {
            continue;
        }

        const body = bodies.get(`${ev.sessionId ?? ""} ${ev.params.requestId}`);
        if (body !== undefined) {
            (ev.params.response as { body?: string }).body = body;
            stitched++;
        }
    }

    return stitched;
}

export interface BufferHarResult {
    har: HarFile;
    eventCount: number;
    droppedFailed: number;
    /** Requests Local Network Access blocked; `grant` allows them. */
    localNetworkBlocked: number;
    stitchedBodies: number;
    /** Event-time coverage of the WHOLE buffer, so an empty window is diagnosable. */
    coverage: { totalEvents: number; oldestT: number | null; newestT: number | null };
}

/**
 * Page lifecycle events that anchor entries to a page in the HAR builder.
 * A `--last` window that starts AFTER the navigation contains only network
 * events; without an anchor every entry stays page-less and the builder drops
 * them all — `har --last 40s` returned 0 entries for a window full of traffic
 * (field-verified). So windowed builds prepend the pre-window anchors; pages
 * that end up with no entries are pruned by the builder, never invented.
 */
const PAGE_ANCHOR_METHODS = new Set([
    "Page.frameStartedLoading",
    "Page.frameRequestedNavigation",
    "Page.navigatedWithinDocument",
    "Page.frameNavigated",
    "Page.frameAttached",
]);

export function buildHarFromBuffer(opts: {
    port: number;
    sinceMs?: number;
    match?: string;
    /** Capture dir override (tests). Defaults to the port's real dir. */
    dir?: string;
}): BufferHarResult {
    const all = readEvents(opts.dir ?? captureDir(opts.port));
    const coverage = {
        totalEvents: all.length,
        oldestT: all.length ? all[0].t : null,
        newestT: all.length ? all[all.length - 1].t : null,
    };

    let events = all;
    if (opts.sinceMs !== undefined) {
        const since = opts.sinceMs;
        const anchors = all.filter((e) => e.t < since && PAGE_ANCHOR_METHODS.has(e.method));
        events = [...anchors, ...all.filter((e) => e.t >= since)];
    }

    const stitchedBodies = stitchBodies(events);
    const har = harFromMessages(events as CdpMessage[], { includeTextFromResponseBody: stitchedBodies > 0 });

    if (opts.match) {
        const m = opts.match;
        har.log.entries = har.log.entries.filter(
            (e) => e.request.url.includes(m) || (e.response?.redirectURL ?? "").includes(m)
        );
    }

    return {
        har,
        eventCount: events.length,
        droppedFailed: countDroppedFailures(events),
        localNetworkBlocked: countLocalNetworkBlocks(events),
        stitchedBodies,
        coverage,
    };
}

export interface LiveWindowResult {
    har: HarFile;
    bodiesGot: number;
    bodiesMiss: number;
    droppedFailed: number;
    /** Requests Local Network Access blocked; `grant` allows them. */
    localNetworkBlocked: number;
    pageUrl: string;
}

/** `har --now [--reload]`: one tab, a recording window, optional body fetch. */
export async function captureLiveWindow(opts: {
    port: number;
    match?: string;
    reload?: boolean;
    seconds: number;
    bodies: boolean;
    onAttached?: (page: Page) => void;
}): Promise<LiveWindowResult> {
    const page = await attach({ port: opts.port, url: opts.match });
    opts.onAttached?.(page);
    const messages: CdpMessage[] = [];
    page.on((method, params) => {
        if (method.startsWith("Network.") || method.startsWith("Page.")) {
            messages.push({ method, params });
        }
    });

    await page
        .send("Network.enable", {
            maxTotalBufferSize: 100_000_000,
            maxResourceBufferSize: 50_000_000,
            maxPostDataSize: 10_000_000,
        })
        .catch((err: unknown) => {
            log.warn({ err }, "Network.enable failed");
        });

    if (opts.reload) {
        await page.reload();
    }

    await Bun.sleep(opts.seconds * 1000);

    let bodiesGot = 0;
    let bodiesMiss = 0;

    if (opts.bodies) {
        const ids = [
            ...new Set(
                messages.filter((m) => m.method === "Network.responseReceived").map((m) => String(m.params.requestId))
            ),
        ];

        for (const id of ids) {
            try {
                const r = await page.responseBody(id);
                if (r?.body != null) {
                    const resp = messages.find(
                        (m) => m.method === "Network.responseReceived" && String(m.params.requestId) === id
                    );
                    if (resp) {
                        (resp.params.response as { body?: string }).body = r.body;
                        bodiesGot++;
                    }
                } else {
                    bodiesMiss++;
                }
            } catch (err) {
                bodiesMiss++;
                log.debug({ err, id }, "body miss");
            }
        }
    }

    const har = harFromMessages(messages, { includeTextFromResponseBody: opts.bodies });
    const pageUrl = page.target.url;
    page.close();

    return {
        har,
        bodiesGot,
        bodiesMiss,
        droppedFailed: countDroppedFailures(messages),
        localNetworkBlocked: countLocalNetworkBlocks(messages),
        pageUrl,
    };
}

/** Redact Cookie / Set-Cookie / Authorization headers, cookie values, and credential-shaped POST params. */
const SENSITIVE_PARAM =
    /^(password|passwd|pwd|secret|authorization|code|access_token|refresh_token|id_token|id_token_hint|token|client_secret)$/i;

/** Headers whose value is a URL, where an OAuth `?code=` rides along a redirect (`Location`) or the next request. */
const URL_HEADERS = new Set(["location", "content-location", "referer"]);

/** A query or form name as the server reads it: `co%64e` is `code`. A malformed escape is matched as written. */
function isSensitiveParam(name: string): boolean {
    let decoded = name;

    try {
        decoded = decodeURIComponent(name.replaceAll("+", " "));
    } catch {
        // A lone "%" is no escape: the name stays as written, and the raw match below still runs.
    }

    return SENSITIVE_PARAM.test(decoded) || SENSITIVE_PARAM.test(name);
}

function redactJsonDeep(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(redactJsonDeep);
    }

    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(value)) {
            out[key] = SENSITIVE_PARAM.test(key) ? "[REDACTED]" : redactJsonDeep(v);
        }

        return out;
    }

    return value;
}

/** Redact sensitive query params (and any fragment) inside a URL string. OAuth ?code= lives here. */
function redactUrl(url: string): string {
    return url
        .replace(/([?&])([^=&#]+)=([^&#]*)/g, (all, sep: string, name: string, _v) =>
            isSensitiveParam(name) ? `${sep}${name}=[REDACTED]` : all
        )
        .replace(/#.+$/, "#[REDACTED]");
}

/** One URL-encoded `name=value` pair: `&` or a line break ends it. */
const FORM_PAIR = /(^|[&\r\n])([^=&\r\n]+)=([^&\r\n]*)/g;

/**
 * One text/plain form pair: only a line break ends it, because `&` is a literal character of a text/plain value
 * (`password=first&rest` is one password). A URL-encoded body holds no raw line break, so its pairs never get here.
 */
const LINE_PAIR = /(^|[\r\n])([^=\r\n]+)=([^\r\n]*)/g;

/** One multipart/form-data part: its headers (one names the field), a blank line, then its value up to the boundary. */
const MULTIPART_PART =
    /(content-disposition:[^\r\n]*\bname="([^"]*)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([\s\S]*?)(?=\r?\n--)/gi;

/**
 * The credentials in a non-JSON POST body: multipart parts, then text/plain lines, then URL-encoded pairs. Only a
 * body declared URL-encoded skips the line pass; any other body (text/plain, also `fetch` with a string body) may
 * carry a value with `&` in it, so a sensitive line is redacted to its end and the `&` pass still runs after it.
 */
function redactFormText(text: string, mimeType: string | undefined): string {
    const urlEncoded = /^\s*application\/x-www-form-urlencoded\b/i.test(mimeType ?? "");
    const parts = text.replace(MULTIPART_PART, (part, head: string, name: string) =>
        isSensitiveParam(name) ? `${head}[REDACTED]` : part
    );
    const lines = urlEncoded
        ? parts
        : parts.replace(LINE_PAIR, (pair, separator: string, name: string) =>
              isSensitiveParam(name) ? `${separator}${name}=[REDACTED]` : pair
          );

    return lines.replace(FORM_PAIR, (pair, separator: string, name: string) =>
        isSensitiveParam(name) ? `${separator}${name}=[REDACTED]` : pair
    );
}

export function sanitizeHar(har: HarFile): HarFile {
    const clone = structuredClone(har);

    // The builder titles a page with its navigation URL, so an OAuth ?code= sits in the title too.
    for (const page of clone.log.pages) {
        if (/^https?:/i.test(page.title)) {
            page.title = redactUrl(page.title);
        }
    }

    for (const entry of clone.log.entries) {
        entry.request.url = redactUrl(entry.request.url);
        for (const q of entry.request.queryString ?? []) {
            if (isSensitiveParam(q.name)) {
                q.value = "[REDACTED]";
            }
        }

        if (entry.response?.redirectURL) {
            entry.response.redirectURL = redactUrl(entry.response.redirectURL);
        }

        for (const h of [...entry.request.headers, ...(entry.response?.headers ?? [])]) {
            if (sensitiveHeaderKind(h.name) !== null) {
                h.value = "[REDACTED]";
            } else if (URL_HEADERS.has(h.name.toLowerCase())) {
                h.value = redactUrl(h.value);
            }
        }

        for (const c of [...entry.request.cookies, ...(entry.response?.cookies ?? [])]) {
            c.value = "[REDACTED]";
        }

        const postData = entry.request.postData;
        if (postData?.text) {
            // JSON bodies get a structural deep-redaction ({"access_token": …});
            // everything else falls back to the form pattern pass (`redactFormText`).
            let handled = false;
            if (/^\s*[{[]/.test(postData.text)) {
                try {
                    const parsed = SafeJSON.parse(postData.text, { strict: true });
                    postData.text = SafeJSON.stringify(redactJsonDeep(parsed), { strict: true });
                    handled = true;
                } catch (err) {
                    log.debug({ err }, "postData looked like JSON but did not parse; regex redaction applies");
                }
            }

            if (!handled) {
                postData.text = redactFormText(postData.text, postData.mimeType);
            }
        }

        for (const param of postData?.params ?? []) {
            if (isSensitiveParam(param.name)) {
                param.value = "[REDACTED]";
            }
        }
    }

    return clone;
}
