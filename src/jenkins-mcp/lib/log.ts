import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import logger from "@app/logger";
import type { AxiosInstance } from "axios";
import { slugify } from "./format";

const TMP_DIR = "/tmp/jenkins-mcp";
const MAX_BYTES = 50 * 1024 * 1024;

const TIMESTAMP_SPAN_RE =
    /<span class="timestamp"><b>[^<]*<\/b>\s*<\/span><span style="display: none">\[[^\]]+\]<\/span>/g;
const ANY_SPAN_RE = /<span[^>]*>|<\/span>/g;

export function stripJenkinsHtml(text: string): string {
    return text.replace(TIMESTAMP_SPAN_RE, "").replace(ANY_SPAN_RE, "");
}

export interface LogFetchOpts {
    /** If set, fetch this node's log via wfapi instead of whole build. */
    nodeId?: string;
    /** Cap bytes saved/processed (default 50MB). */
    maxBytes?: number;
}

export interface LogResult {
    path: string;
    sizeBytes: number;
    lineCount: number;
    nodeStatus?: string;
    truncated: boolean;
}

export interface LogFilterOpts {
    tail?: number;
    head?: number;
    grep?: string;
}

export interface LogPreview {
    first: string[];
    last: string[];
    grepMatches?: { line: number; text: string }[];
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

    const slug = slugify(jobPath);
    const file = opts.nodeId
        ? join(TMP_DIR, `${slug}-${buildNumber}-node${opts.nodeId}.log`)
        : join(TMP_DIR, `${slug}-${buildNumber}.log`);

    let raw: string;
    let nodeStatus: string | undefined;

    if (opts.nodeId) {
        const chunks: string[] = [];
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
            nodeStatus = body.nodeStatus;
            const totalSoFar = chunks.reduce((sum, c) => sum + c.length, 0);

            if (!body.hasMore || totalSoFar >= maxBytes) {
                break;
            }

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
    const clean = stripJenkinsHtml(raw);
    await writeFile(file, clean, "utf8");

    const lineCount = clean === "" ? 0 : clean.split("\n").length - (clean.endsWith("\n") ? 1 : 0);
    logger.debug(`Wrote Jenkins log to ${file} (${clean.length}B, ${lineCount} lines)`);

    return { path: file, sizeBytes: clean.length, lineCount, nodeStatus, truncated };
}

export async function readLogPreview(filePath: string, opts: LogFilterOpts = {}): Promise<LogPreview> {
    const content = await Bun.file(filePath).text();
    const lines = content.split("\n");

    const headCount = opts.head ?? 10;
    const tailCount = opts.tail ?? 10;
    const first = lines.slice(0, headCount);
    const last = tailCount > 0 ? lines.slice(-tailCount) : [];

    let grepMatches: { line: number; text: string }[] | undefined;

    if (opts.grep) {
        const re = new RegExp(opts.grep);
        grepMatches = [];

        for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
                grepMatches.push({ line: i + 1, text: lines[i] });

                if (grepMatches.length >= 200) {
                    break;
                }
            }
        }
    }

    return { first, last, grepMatches };
}
