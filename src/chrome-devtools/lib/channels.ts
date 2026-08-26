/**
 * Channel vocabulary, in two layers:
 *
 * - CAPTURE channels tell the recorder what to put into the buffer. `net` is
 *   the chrome-har diet (HAR-grade metadata) and is always on; the rest cost
 *   CPU or perform active CDP calls, so they are explicit.
 * - RENDER channels tell `follow` which lines to show. They are free — all
 *   derived from what the buffer already holds.
 */

export const CAPTURE_CHANNELS = ["net", "console", "ws", "body", "storage"] as const;
export type CaptureChannel = (typeof CAPTURE_CHANNELS)[number];

export const DEFAULT_CAPTURE_CHANNELS: CaptureChannel[] = ["net", "console"];

export const CAPTURE_CHANNEL_HELP: Record<CaptureChannel, string> = {
    net: "HAR-grade network + page metadata (always on; requests, redirects, headers, timings)",
    console: "console messages, thrown exceptions, browser log entries",
    ws: "websocket FRAMES (high-rate; scope with --match, adds CPU)",
    body: "response bodies up to 2 KB, fetched at loadingFinished (active CDP calls)",
    storage: "local/sessionStorage snapshot on every navigation (active JS evaluation)",
};

export const RENDER_CHANNELS = [
    "nav",
    "doc",
    "redirect",
    "xhr",
    "ws",
    "console",
    "error",
    "cookie",
    "body",
    "storage",
] as const;
export type RenderChannel = (typeof RENDER_CHANNELS)[number];

export const RENDER_CHANNEL_HELP: Record<RenderChannel, string> = {
    nav: "main-frame navigations",
    doc: "document requests",
    redirect: "3xx hops with Location and Set-Cookie",
    xhr: "XHR/fetch requests and their response status",
    ws: "websocket lifecycle, plus frames when the recorder captures the ws channel",
    console: "console messages",
    error: "console errors, exceptions, failed requests",
    cookie: "every Set-Cookie seen",
    body: "captured response bodies (needs the recorder's body channel)",
    storage: "storage snapshots (needs the recorder's storage channel)",
};

/** Which recorder CAPTURE channel a render channel depends on beyond `net`. */
export const RENDER_NEEDS_CAPTURE: Partial<Record<RenderChannel, CaptureChannel>> = {
    console: "console",
    error: "console",
    ws: "ws",
    body: "body",
    storage: "storage",
};

export function parseChannels<T extends string>(
    raw: string,
    valid: readonly T[],
    defaults: T[]
): { channels: T[]; invalid: string[] } {
    const trimmed = raw.trim();
    if (!trimmed) {
        return { channels: defaults, invalid: [] };
    }

    const additive = trimmed.startsWith("+");
    const names = (additive ? trimmed.slice(1) : trimmed)
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
    const invalid = names.filter((n) => !(valid as readonly string[]).includes(n));
    const picked = names.filter((n): n is T => (valid as readonly string[]).includes(n));
    const channels = additive ? [...new Set([...defaults, ...picked])] : [...new Set(picked)];

    return { channels: channels.length ? channels : defaults, invalid };
}

export function channelHelpLines(help: Record<string, string>): string[] {
    return Object.entries(help).map(([name, text]) => `  ${name.padEnd(8)} ${text}`);
}

/** One recorded buffer line. `Genesis.*` methods are recorder-synthesized (invisible to the HAR builder). */
export interface RecordedEvent {
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
    /** Wall-clock epoch ms at record time. */
    t: number;
}

function fmtTime(epochMs: number): string {
    const d = new Date(epochMs);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");

    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function setCookieOf(headers: Record<string, string> | undefined): string {
    if (!headers) {
        return "";
    }

    return Object.entries(headers)
        .filter(([k]) => k.toLowerCase() === "set-cookie")
        .map(([, v]) => v)
        .join(" | ");
}

/**
 * Render one recorded event as zero or more human lines for the chosen render
 * channels. Ported from the old skill's `watch` formatting.
 */
export function renderEventLines(
    ev: RecordedEvent,
    on: ReadonlySet<RenderChannel>,
    matches: (url: string) => boolean
): string[] {
    const lines: string[] = [];
    const t = fmtTime(ev.t);
    const emit = (kind: string, rest: string) => {
        lines.push(`${t} ${kind.toUpperCase().padEnd(8)} ${rest}`);
    };

    const p = ev.params;

    switch (ev.method) {
        case "Page.frameNavigated": {
            const frame = p.frame as { parentId?: string; url: string } | undefined;
            if (frame && !frame.parentId && on.has("nav") && matches(frame.url)) {
                emit("nav", frame.url);
            }

            break;
        }

        case "Network.requestWillBeSent": {
            const req = p.request as { url: string; method: string; postData?: string } | undefined;
            const redirect = p.redirectResponse as
                | { status: number; url: string; headers?: Record<string, string> }
                | undefined;

            if (redirect && on.has("redirect") && matches(redirect.url)) {
                const h = redirect.headers ?? {};
                const sc = setCookieOf(h);
                emit(
                    "redirect",
                    `${redirect.status} ${redirect.url} -> ${h.location ?? h.Location ?? "(no Location)"}${sc ? `  set-cookie: ${sc}` : ""}`
                );
            }

            if (!req || !matches(req.url)) {
                break;
            }

            if (p.type === "Document" && on.has("doc")) {
                emit("doc", `${req.method} ${req.url}`);
            }

            if ((p.type === "XHR" || p.type === "Fetch") && on.has("xhr")) {
                emit("xhr", `${req.method} ${req.url}${req.postData ? ` post=${req.postData.slice(0, 300)}` : ""}`);
            }

            break;
        }

        case "Network.responseReceived": {
            const res = p.response as { status: number; url: string; headers?: Record<string, string> } | undefined;
            if (!res || !matches(res.url)) {
                break;
            }

            if ((p.type === "XHR" || p.type === "Fetch") && on.has("xhr")) {
                emit("resp", `${res.status} ${res.url}`);
            }

            if (on.has("cookie")) {
                const sc = setCookieOf(res.headers);
                if (sc) {
                    emit("cookie", `${res.url} set-cookie: ${sc}`);
                }
            }

            break;
        }

        case "Network.responseReceivedExtraInfo": {
            if (on.has("cookie")) {
                const sc = setCookieOf(p.headers as Record<string, string> | undefined);
                if (sc) {
                    emit("cookie", `(raw) set-cookie: ${sc}`);
                }
            }

            break;
        }

        case "Network.loadingFailed": {
            if (on.has("error") || on.has("xhr")) {
                emit("fail", `${p.errorText} type=${p.type} (${p.requestId})`);
            }

            break;
        }

        case "Network.webSocketCreated": {
            if (on.has("ws")) {
                emit("ws", `created ${p.url}`);
            }

            break;
        }

        case "Network.webSocketClosed": {
            if (on.has("ws")) {
                emit("ws", `closed (${p.requestId})`);
            }

            break;
        }

        case "Network.webSocketFrameSent":
        case "Network.webSocketFrameReceived": {
            if (on.has("ws")) {
                const dir = ev.method.endsWith("Sent") ? "->" : "<-";
                const payload = (p.response as { payloadData?: string } | undefined)?.payloadData ?? "";
                emit("ws", `${dir} ${String(payload).slice(0, 500)}`);
            }

            break;
        }

        case "Runtime.consoleAPICalled": {
            const args = (p.args ?? []) as { value?: unknown; description?: string; type?: string }[];
            const text = args.map((a) => a.value ?? a.description ?? a.type).join(" ");
            const isErr = p.type === "error" || p.type === "assert";

            if ((isErr && on.has("error")) || (!isErr && on.has("console"))) {
                emit(isErr ? "cerror" : "console", `[${p.type}] ${text.slice(0, 800)}`);
            }

            break;
        }

        case "Runtime.exceptionThrown": {
            if (on.has("error")) {
                const details = p.exceptionDetails as
                    | { text?: string; exception?: { description?: string } }
                    | undefined;
                emit("throw", String(details?.exception?.description ?? details?.text ?? "").slice(0, 800));
            }

            break;
        }

        case "Log.entryAdded": {
            const entry = p.entry as { level: string; text: string } | undefined;
            if (!entry) {
                break;
            }

            if ((entry.level === "error" && on.has("error")) || (entry.level !== "error" && on.has("console"))) {
                emit(
                    entry.level === "error" ? "cerror" : "console",
                    `[${entry.level}] ${String(entry.text).slice(0, 800)}`
                );
            }

            break;
        }

        case "Genesis.responseBody": {
            if (on.has("body") && matches(String(p.url ?? ""))) {
                emit("body", `${p.url} ${String(p.body ?? "").slice(0, 2000)}`);
            }

            break;
        }

        case "Genesis.storageSnapshot": {
            if (on.has("storage")) {
                emit("storage", `${p.url} ls=${p.ls} ss=${p.ss} lsKeys=${SafeStringify(p.lsKeys)}`);
            }

            break;
        }

        case "Genesis.marker": {
            emit("marker", `${p.kind}${p.detail ? ` ${p.detail}` : ""}`);
            break;
        }

        default:
            break;
    }

    return lines;
}

function SafeStringify(v: unknown): string {
    if (Array.isArray(v)) {
        return v.map(String).join(",");
    }

    return String(v ?? "");
}

/** Monitor / follow-up commands tailored to the chosen render channels (ported from watch.ts). */
export function monitorHints(out: string, channels: RenderChannel[]): string[] {
    const hints: string[] = [];
    const has = (c: RenderChannel) => channels.includes(c);
    const pats: string[] = [];

    if (has("redirect")) {
        pats.push("REDIRECT");
    }

    if (has("error")) {
        pats.push("CERROR", "THROW", "FAIL");
    }

    if (has("nav")) {
        pats.push("NAV");
    }

    if (has("cookie")) {
        pats.push("COOKIE");
    }

    hints.push(`tail -f ${out}    # everything, live`);

    if (pats.length) {
        hints.push(
            `tail -f ${out} | grep --line-buffered -E '${pats.join("|")}'    # Monitor tool: wakes per matching event`
        );
    }

    if (has("redirect")) {
        hints.push(
            `tail -f ${out} | grep --line-buffered -E 'REDIRECT.*(no Location|commonauth|error|retry)'    # bad OAuth hop only`
        );
        hints.push(`rg -n 'REDIRECT' ${out}    # after the fact: the whole hop chain`);
    }

    if (has("error")) {
        hints.push(`tail -f ${out} | grep --line-buffered -E 'CERROR|THROW|FAIL'    # failures only`);
    }

    if (has("xhr")) {
        hints.push(`rg -n 'RESP     (4|5)' ${out}    # after the fact: failed API calls`);
    }

    return hints;
}
