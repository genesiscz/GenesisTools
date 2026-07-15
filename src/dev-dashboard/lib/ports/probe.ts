import { parseHtmlTitle } from "@app/dev-dashboard/lib/ports/enrich-parse";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

export type HttpContentClass = "html" | "json" | "text" | "other" | "none";

export interface HttpProbeResult {
    http: boolean;
    contentClass: HttpContentClass;
    title: string | null;
}

const HTTP_PROBE_TIMEOUT_MS = 350;

/**
 * Probe localhost:port once. Classifies body/content-type as html | json | text | other | none.
 * Never throws — failures become `{ http: false, contentClass: "none" }`.
 */
export async function probeHttp(port: number): Promise<HttpProbeResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_PROBE_TIMEOUT_MS);

    try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
            signal: controller.signal,
            redirect: "manual",
            headers: { Accept: "text/html, application/json, text/plain, */*" },
        });

        const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
        const ctClass = classFromContentType(contentType);

        if (ctClass === "html" || contentType.includes("text/html")) {
            const body = await res.text();
            return { http: true, contentClass: "html", title: parseHtmlTitle(body) };
        }

        if (ctClass === "json") {
            await res.body?.cancel();
            return { http: true, contentClass: "json", title: null };
        }

        if (ctClass === "text") {
            await res.body?.cancel();
            return { http: true, contentClass: "text", title: null };
        }

        // Unknown content-type: peek at a small prefix to detect HTML/JSON.
        const peek = await res.text();
        const peeked = classifyBodyPeek(peek);
        if (peeked === "html") {
            return { http: true, contentClass: "html", title: parseHtmlTitle(peek) };
        }

        if (peeked === "json") {
            return { http: true, contentClass: "json", title: null };
        }

        if (peeked === "text" && peek.trim().length > 0) {
            return { http: true, contentClass: "text", title: null };
        }

        return { http: true, contentClass: "other", title: null };
    } catch (err) {
        logger.debug({ err, port }, "ports/probe: http probe failed");
        return { http: false, contentClass: "none", title: null };
    } finally {
        clearTimeout(timeout);
    }
}

export function classFromContentType(contentType: string): HttpContentClass | null {
    const ct = contentType.toLowerCase();
    if (ct.includes("text/html") || ct.includes("application/xhtml")) {
        return "html";
    }

    if (ct.includes("application/json") || ct.includes("+json")) {
        return "json";
    }

    if (ct.startsWith("text/plain") || ct.startsWith("text/csv") || ct.includes("text/plain")) {
        return "text";
    }

    return null;
}

/** Best-effort body sniff when Content-Type is missing/generic. */
export function classifyBodyPeek(body: string): HttpContentClass {
    const trimmed = body.trimStart();
    if (!trimmed) {
        return "other";
    }

    if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<!doctype") || /^<html[\s>]/i.test(trimmed)) {
        return "html";
    }

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            SafeJSON.parse(trimmed.slice(0, Math.min(trimmed.length, 8_000)), { strict: true });
            return "json";
        } catch {
            // not json
        }
    }

    // Plain text if no control chars / looks readable and not binary-ish
    const sample = trimmed.slice(0, 200);
    let binary = false;
    for (let i = 0; i < sample.length; i++) {
        const code = sample.charCodeAt(i);
        if (code <= 8 || (code >= 14 && code <= 31)) {
            binary = true;
            break;
        }
    }

    if (!binary) {
        return "text";
    }

    return "other";
}
