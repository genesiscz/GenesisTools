/**
 * HAR assembly on top of the capture buffer (retroactive) or a live window.
 * The conversion itself is the chrome-har port in ./har/build.ts.
 */
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { attach, type Page } from "./cdp.ts";
import type { RecordedEvent } from "./channels.ts";
import { harFromMessages } from "./har/build.ts";
import type { CdpMessage, HarFile } from "./har/types.ts";
import { captureDir } from "./paths.ts";
import { readEvents } from "./segments.ts";

const { log } = logger.scoped("chrome-devtools:har-io");

const SENSITIVE_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-csrf-token)$/i;

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
        stitchedBodies,
        coverage,
    };
}

export interface LiveWindowResult {
    har: HarFile;
    bodiesGot: number;
    bodiesMiss: number;
    droppedFailed: number;
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

    return { har, bodiesGot, bodiesMiss, droppedFailed: countDroppedFailures(messages), pageUrl };
}

/** Redact Cookie / Set-Cookie / Authorization headers, cookie values, and credential-shaped POST params. */
const SENSITIVE_PARAM =
    /^(password|passwd|pwd|secret|authorization|code|access_token|refresh_token|id_token|token|client_secret)$/i;

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
            SENSITIVE_PARAM.test(name) ? `${sep}${name}=[REDACTED]` : all
        )
        .replace(/#.+$/, "#[REDACTED]");
}

export function sanitizeHar(har: HarFile): HarFile {
    const clone = structuredClone(har);

    for (const entry of clone.log.entries) {
        entry.request.url = redactUrl(entry.request.url);
        for (const q of entry.request.queryString ?? []) {
            if (SENSITIVE_PARAM.test(q.name)) {
                q.value = "[REDACTED]";
            }
        }

        if (entry.response?.redirectURL) {
            entry.response.redirectURL = redactUrl(entry.response.redirectURL);
        }

        for (const h of [...entry.request.headers, ...(entry.response?.headers ?? [])]) {
            if (SENSITIVE_HEADER.test(h.name)) {
                h.value = "[REDACTED]";
            }
        }

        for (const c of [...entry.request.cookies, ...(entry.response?.cookies ?? [])]) {
            c.value = "[REDACTED]";
        }

        const postData = entry.request.postData;
        if (postData?.text) {
            // JSON bodies get a structural deep-redaction ({"access_token": …});
            // everything else falls back to the URL-encoded pattern pass.
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
                postData.text = postData.text.replace(
                    /(password|passwd|pwd|secret|token|code)=([^&]*)/gi,
                    "$1=[REDACTED]"
                );
            }
        }

        for (const param of postData?.params ?? []) {
            if (SENSITIVE_PARAM.test(param.name)) {
                param.value = "[REDACTED]";
            }
        }
    }

    return clone;
}
