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

export function stripJenkinsHtml(text: string): string {
    return text.replace(TIMESTAMP_SPAN_RE, "").replace(ANY_SPAN_RE, "");
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

interface NodeLogResponse {
    nodeId?: string;
    nodeStatus?: string;
    length?: number;
    hasMore?: boolean;
    text?: string;
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
        const chunks: string[] = [];
        let totalSoFar = 0;
        let start = 0;

        for (;;) {
            const res = await client.get(`/${jobPath}/${buildNumber}/execution/node/${opts.nodeId}/wfapi/log`, {
                params: start > 0 ? { start } : undefined,
            });

            if (res.status === 404) {
                throw new Error(`Node ${opts.nodeId} not found on build ${buildNumber}`);
            }

            if (res.status !== 200) {
                throw new Error(`wfapi/log returned ${res.status}`);
            }

            const body = res.data as NodeLogResponse;
            const text = body.text ?? "";
            chunks.push(text);
            totalSoFar += text.length;
            nodeStatus = body.nodeStatus;

            if (!body.hasMore || totalSoFar >= maxBytes) {
                break;
            }

            // Jenkins's `length` field is the server-side cursor (cumulative bytes emitted),
            // which is exactly what to pass back as `start` next round.
            start = body.length ?? totalSoFar;
        }

        raw = chunks.join("");
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
 * Walks the string with indexOf("\n") so a 26MB / 242k-line log doesn't allocate
 * a 242k-element String[] up front just to scan it. Only the (up to 200) match
 * strings are allocated.
 */
export function grepLog(content: string, pattern: string): string[] {
    const re = new RegExp(pattern);
    const matches: string[] = [];
    let lineNumber = 0;
    let start = 0;

    while (start <= content.length) {
        const nl = content.indexOf("\n", start);
        const end = nl === -1 ? content.length : nl;

        if (end > start) {
            lineNumber++;
            re.lastIndex = 0;
            const line = content.slice(start, end);

            if (re.test(line)) {
                matches.push(`L${lineNumber}: ${line.replace(/\r$/, "")}`);

                if (matches.length >= 200) {
                    return matches;
                }
            }
        } else if (nl !== -1) {
            // Empty line (two consecutive newlines or leading newline) — count it.
            lineNumber++;
        }

        if (nl === -1) {
            break;
        }

        start = nl + 1;
    }

    return matches;
}
