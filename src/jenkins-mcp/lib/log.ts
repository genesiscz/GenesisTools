import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import logger from "@app/logger";
import type { AxiosInstance } from "axios";
import { slugifyJobPath } from "./format";

const TMP_DIR = "/tmp/jenkins-mcp";
const MAX_BYTES = 50 * 1024 * 1024;

const TIMESTAMP_SPAN_RE =
    /<span class="timestamp"><b>[^<]*<\/b>\s*<\/span><span style="display: none">\[[^\]]+\]<\/span>/g;
const ANY_SPAN_RE = /<span[^>]*>|<\/span>/g;
const CONSOLE_OUTPUT_RE = /<pre class="console-output">([\s\S]*?)<\/pre>/;
const HTML_ENTITIES: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
};

export function stripJenkinsHtml(text: string): string {
    return text.replace(TIMESTAMP_SPAN_RE, "").replace(ANY_SPAN_RE, "");
}

/**
 * Parse the HTML returned by `/execution/node/{id}/log/?consoleFull`:
 *   1. Extract the <pre class="console-output">…</pre> body.
 *   2. URL-decode it (Jenkins URL-encodes the inner text).
 *   3. Strip the Jenkins per-line timestamp <span> wrappers.
 *   4. Unescape HTML entities (&lt; &amp; etc).
 * Returns the cleaned plaintext log content.
 *
 * Throws if the HTML doesn't contain a <pre class="console-output"> block —
 * indicates Jenkins returned an unexpected page (error page, redirect, etc.).
 */
export function parseConsoleFullHtml(html: string): string {
    const m = CONSOLE_OUTPUT_RE.exec(html);
    if (!m) {
        throw new Error("consoleFull response missing <pre class='console-output'> block");
    }

    // Jenkins URL-encodes the inner text but emits literal `%` from build output
    // unchanged (e.g. "25%" in progress bars), so decodeURIComponent throws.
    // Decode only well-formed %XX byte sequences, pass everything else through.
    const urlDecoded = m[1].replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
        try {
            return decodeURIComponent(seq);
        } catch {
            return seq;
        }
    });
    const noSpans = stripJenkinsHtml(urlDecoded);
    return noSpans.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (e) => HTML_ENTITIES[e] ?? e);
}

export async function isBuildFinal(client: AxiosInstance, jobPath: string, buildNumber: string): Promise<boolean> {
    const res = await client.get(`/${jobPath}/${buildNumber}/api/json`, {
        params: { tree: "building,result" },
    });

    if (res.status !== 200) {
        return false;
    }

    const data = res.data as { building?: boolean; result?: string | null };
    return data.building === false && data.result != null;
}

export interface LogFetchOpts {
    /** If set, fetch this node's log via wfapi instead of whole build. */
    nodeId?: string;
    /** Cap bytes saved/processed (default 50MB). */
    maxBytes?: number;
}

export interface LogResult {
    path: string;
    /** Cleaned (HTML-stripped) log content — same bytes as written to `path`. */
    content: string;
    sizeBytes: number;
    lineCount: number;
    nodeStatus?: string;
    truncated: boolean;
}

/**
 * Read a previously-written log file from /tmp/jenkins-mcp. Returns null if
 * absent. Caller decides freshness — typically by checking isBuildFinal first.
 * nodeStatus is left undefined on cache hits (callers that need it already
 * have it via the stage snapshot).
 */
export async function readCachedLog(
    jobPath: string,
    buildNumber: string,
    nodeId?: string,
    maxBytes: number = MAX_BYTES
): Promise<LogResult | null> {
    const slug = slugifyJobPath(jobPath);
    const path = nodeId
        ? join(TMP_DIR, `${slug}-${buildNumber}-node${nodeId}.log`)
        : join(TMP_DIR, `${slug}-${buildNumber}.log`);

    let sizeBytes: number;

    try {
        const s = await stat(path);
        sizeBytes = s.size;
    } catch {
        return null;
    }

    const content = await readFile(path, "utf8");
    const lineCount = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);

    return {
        path,
        content,
        sizeBytes,
        lineCount,
        nodeStatus: undefined,
        truncated: sizeBytes >= maxBytes,
    };
}

export async function fetchLog(
    client: AxiosInstance,
    jobPath: string,
    buildNumber: string,
    opts: LogFetchOpts = {}
): Promise<LogResult> {
    const maxBytes = opts.maxBytes ?? MAX_BYTES;
    await mkdir(TMP_DIR, { recursive: true });

    const slug = slugifyJobPath(jobPath);
    const file = opts.nodeId
        ? join(TMP_DIR, `${slug}-${buildNumber}-node${opts.nodeId}.log`)
        : join(TMP_DIR, `${slug}-${buildNumber}.log`);

    const cached = await readCachedLog(jobPath, buildNumber, opts.nodeId, maxBytes);
    if (cached && (await isBuildFinal(client, jobPath, buildNumber))) {
        logger.debug(`Reusing cached Jenkins log ${file} (${cached.sizeBytes}B, ${cached.lineCount} lines)`);
        return cached;
    }

    let raw: string;
    let nodeStatus: string | undefined;

    if (opts.nodeId) {
        // Fetch the whole node log in one shot via /log/?consoleFull. The wfapi/log
        // endpoint is unsuitable here: at least on Jenkins 2.x it returns 10KB
        // chunks and IGNORES the `start` query parameter on subsequent calls, so
        // pagination loops forever and accumulates duplicated content. The HTML
        // log viewer endpoint returns the full text in a single response.
        const res = await client.get(`/${jobPath}/${buildNumber}/execution/node/${opts.nodeId}/log/?consoleFull`, {
            responseType: "text",
            maxContentLength: maxBytes * 4, // HTML inflates ~3-4x vs decoded text
            transformResponse: [(d) => d as string],
        });

        if (res.status === 404) {
            throw new Error(`Node ${opts.nodeId} not found on build ${buildNumber}`);
        }

        if (res.status !== 200) {
            throw new Error(`consoleFull returned ${res.status}`);
        }

        raw = parseConsoleFullHtml(typeof res.data === "string" ? res.data : "");

        // Pull nodeStatus from a cheap wfapi describe call — consoleFull doesn't include it.
        try {
            const meta = await client.get(`/${jobPath}/${buildNumber}/execution/node/${opts.nodeId}/wfapi/describe`);
            if (meta.status === 200) {
                nodeStatus = (meta.data as { status?: string }).status;
            }
        } catch {
            // nodeStatus is non-critical; cache hits already omit it.
        }
    } else {
        const res = await client.get(`/${jobPath}/${buildNumber}/logText/progressiveText`, {
            params: { start: 0 },
            responseType: "text",
            maxContentLength: maxBytes,
            transformResponse: [(d) => d as string],
        });

        if (res.status === 404) {
            throw new Error(`Build ${buildNumber} log not found (build may have been pruned by retention)`);
        }

        if (res.status !== 200) {
            throw new Error(`progressiveText returned ${res.status}`);
        }

        raw = typeof res.data === "string" ? res.data : "";
    }

    const truncated = raw.length >= maxBytes;
    const content = stripJenkinsHtml(raw);
    await writeFile(file, content, "utf8");

    const lineCount = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    const sizeBytes = Buffer.byteLength(content, "utf8");
    logger.debug(`Wrote Jenkins log to ${file} (${sizeBytes}B, ${lineCount} lines)`);

    return { path: file, content, sizeBytes, lineCount, nodeStatus, truncated };
}

/**
 * Filter `content` by `pattern`, return up to 200 matches formatted `"L<lineno>: <text>"`
 * (grep(1) `-n` style). Trailing `\r` is stripped from each matched line for clean
 * rendering in JSON responses (Jenkins emits CRLF).
 *
 * Note: this allocates a per-line array via split("\n"), but the cost is ~5ms
 * on a 26MB / 242k-line log — negligible vs the (cached) wfapi cost it follows.
 * Kept simple to preserve exact parity with grep(1) line numbering, including
 * empty-line matching.
 */
export function grepLog(content: string, pattern: string): string[] {
    const re = new RegExp(pattern);
    const lines = content.split("\n");
    const matches: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;

        if (re.test(lines[i])) {
            matches.push(`L${i + 1}: ${lines[i].replace(/\r$/, "")}`);

            if (matches.length >= 200) {
                break;
            }
        }
    }

    return matches;
}
