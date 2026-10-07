import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { logger } from "@genesiscz/utils/logger";
import type { AxiosInstance } from "axios";
import { slugifyJobPath } from "./format";
import { getJenkinsMcpStorage } from "./storage";

const MAX_BYTES = 50 * 1024 * 1024;

const TIMESTAMP_SPAN_RE =
    /<span class="timestamp"><b>[^<]*<\/b>\s*<\/span><span style="display: none">\[[^\]]+\]<\/span>/g;
const ANY_SPAN_RE = /<span[^>]*>|<\/span>/g;
// Jenkins decorates URLs in console output with <a href='...'>...</a> tags;
// it can also emit <b>, <i>, etc. via console annotators. Strip all simple
// tags but keep their inner text so URLs and other content survive.
const SIMPLE_TAG_RE = /<\/?(?:a|b|i|u|em|strong|code|tt)\b[^>]*>/gi;
// Jenkins workflow plugin wraps HashAnchored pipeline action IDs in an ANSI
// "conceal" sequence (ESC[8m ... ESC[0m). Invisible in a real TTY, but they
// leak into raw log files as ESC[8mha:////<base64>...ESC[0m noise.
// Built via `new RegExp` (string form) to keep raw ESC out of the source —
// biome's noControlCharactersInRegex rule rejects the literal `\x1b`.
const ESC = "\\x1b";
const ANSI_CONCEAL_HA_RE = new RegExp(`${ESC}\\[8mha:[^${ESC}]*${ESC}\\[0m`, "g");
const CONSOLE_OUTPUT_RE = /<pre class="console-output">([\s\S]*?)<\/pre>/;
/** The same block when the page was cut before its `</pre>`. */
const CONSOLE_OUTPUT_OPEN_RE = /<pre class="console-output">([\s\S]*)$/;
/** How many HTML bytes a `consoleFull` page may take per byte of text cap (timestamp spans inflate ~3-4x). */
const HTML_INFLATION = 4;
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
    return text
        .replace(TIMESTAMP_SPAN_RE, "")
        .replace(ANY_SPAN_RE, "")
        .replace(SIMPLE_TAG_RE, "")
        .replace(ANSI_CONCEAL_HA_RE, "");
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
/**
 * The decoded text of a `consoleFull` page. `cut`: the page was cut at the byte cap, so its
 * `</pre>` may be missing and the text runs to the end of what arrived.
 */
export function parseConsoleFullHtml(html: string, { cut = false }: { cut?: boolean } = {}): string {
    const m = CONSOLE_OUTPUT_RE.exec(html) ?? (cut ? CONSOLE_OUTPUT_OPEN_RE.exec(html) : null);
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

export interface BuildState {
    building: boolean;
    result: string | null;
    duration: number;
}

/**
 * Single-call probe of `/api/json?tree=building,result,duration`. Returns null on
 * non-200 / network failure / malformed payload so callers can treat "no answer"
 * uniformly. Used as wfapi-independent fallback when wfapi's run-level status
 * lags behind the actual build state (common with multibranch dispatcher pipelines).
 */
export async function getBuildState(
    client: AxiosInstance,
    jobPath: string,
    buildNumber: string
): Promise<BuildState | null> {
    let res: { status: number; data: unknown };

    try {
        res = await client.get(`/${jobPath}/${buildNumber}/api/json`, {
            params: { tree: "building,result,duration" },
        });
    } catch {
        return null;
    }

    if (res.status !== 200) {
        return null;
    }

    const data = res.data as { building?: unknown; result?: unknown; duration?: unknown };

    if (typeof data.building !== "boolean") {
        return null;
    }

    return {
        building: data.building,
        result: typeof data.result === "string" ? data.result : null,
        duration: typeof data.duration === "number" ? data.duration : 0,
    };
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
 * Read a previously-written log file from the cache dir. Returns null if
 * absent, or if the file is larger than `maxBytes`: that copy cannot answer
 * this call, and the size comes from `stat`, so an oversized file is never
 * read just to be discarded. Caller decides freshness — typically by checking
 * isBuildFinal first. nodeStatus is left undefined on cache hits (callers that
 * need it already have it via the stage snapshot).
 */
export async function readCachedLog(
    jobPath: string,
    buildNumber: string,
    nodeId?: string,
    maxBytes: number = MAX_BYTES
): Promise<LogResult | null> {
    const path = getJenkinsMcpStorage().getLogPath(slugifyJobPath(jobPath), buildNumber, nodeId);

    let sizeBytes: number;

    try {
        const s = await stat(path);
        sizeBytes = s.size;
    } catch {
        return null;
    }

    if (sizeBytes > maxBytes) {
        logger.debug(`Cached Jenkins log ${path} is ${sizeBytes}B, over this call's ${maxBytes}B cap; not reading it`);
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
    buildRef: string,
    opts: LogFetchOpts = {}
): Promise<LogResult> {
    const maxBytes = opts.maxBytes ?? MAX_BYTES;
    const buildNumber = await resolveBuildNumber(client, jobPath, buildRef);
    const storage = getJenkinsMcpStorage();
    // Persistent cache dir holds the complete markers; $TMPDIR/jenkins-mcp holds the log blobs.
    await storage.ensureDirs();
    await mkdir(storage.getLogDir(), { recursive: true });

    const file = storage.getLogPath(slugifyJobPath(jobPath), buildNumber, opts.nodeId);

    // A log saved while the build still ran is incomplete, so only a fetch that
    // started after the build finished leaves a reusable cache.
    const finalBeforeFetch = await isBuildFinal(client, jobPath, buildNumber);
    const completeMarker = storage.getCompleteMarkerPath(file);
    // Only a finished build's complete copy can be reused, so the file is read only then, and
    // `readCachedLog` refuses a copy over this call's cap from its size alone: returning a 50 MB
    // copy to a caller that asked for 1 KB would skip the cap, and reading it to discard it wastes
    // the read. Such a copy is fetched again through the capped stream instead.
    const reusable = finalBeforeFetch && (await fileExists(completeMarker));
    const cached = reusable ? await readCachedLog(jobPath, buildNumber, opts.nodeId, maxBytes) : null;

    if (cached) {
        logger.debug(`Reusing cached Jenkins log ${file} (${cached.sizeBytes}B, ${cached.lineCount} lines)`);
        return cached;
    }

    const { raw, nodeStatus, truncated }: FetchedLog = opts.nodeId
        ? await fetchNodeLog({ client, jobPath, buildNumber, nodeId: opts.nodeId, maxBytes })
        : await fetchConsoleText({ client, jobPath, buildNumber, maxBytes });

    const content = stripJenkinsHtml(raw);
    await writeFile(file, content, "utf8");

    // Only a WHOLE copy of a finished build is reusable. A copy cut at `maxBytes` gets no marker,
    // so the next call fetches again instead of serving the cut file as `truncated: false`.
    if (finalBeforeFetch && !truncated) {
        await writeFile(completeMarker, new Date().toISOString(), "utf8");
    } else if (finalBeforeFetch) {
        await rm(completeMarker, { force: true });
    }

    const lineCount = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    const sizeBytes = Buffer.byteLength(content, "utf8");
    logger.debug(`Wrote Jenkins log to ${file} (${sizeBytes}B, ${lineCount} lines)`);

    return { path: file, content, sizeBytes, lineCount, nodeStatus, truncated };
}

/**
 * The log cache is keyed by build number, so an alias such as `lastBuild` is resolved
 * first. Caching under the alias would keep serving an older build once it is complete.
 */
export async function resolveBuildNumber(client: AxiosInstance, jobPath: string, buildRef: string): Promise<string> {
    if (/^\d+$/.test(buildRef)) {
        return buildRef;
    }

    const res = await client.get(`/${jobPath}/${buildRef}/api/json`, { params: { tree: "number" } });
    const data: unknown = res.data;
    const number =
        typeof data === "object" && data !== null && "number" in data && typeof data.number === "number"
            ? data.number
            : undefined;

    if (res.status !== 200 || number === undefined) {
        throw new Error(`Could not resolve build ${buildRef} of ${jobPath} (HTTP ${res.status})`);
    }

    return String(number);
}

interface LogRequest {
    client: AxiosInstance;
    jobPath: string;
    buildNumber: string;
    maxBytes: number;
}

interface FetchedLog {
    raw: string;
    /** The log was longer than `maxBytes` and was cut there. */
    truncated: boolean;
    nodeStatus?: string;
}

async function fetchNodeLog({
    client,
    jobPath,
    buildNumber,
    nodeId,
    maxBytes,
}: LogRequest & { nodeId: string }): Promise<FetchedLog> {
    // Fetch the whole node log in one shot via /log/?consoleFull. The wfapi/log
    // endpoint is unsuitable here: at least on Jenkins 2.x it returns 10KB
    // chunks and IGNORES the `start` query parameter on subsequent calls, so
    // pagination loops forever and accumulates duplicated content. The HTML
    // log viewer endpoint returns the full text in a single response.
    //
    // Streamed and cut like the whole-build path: `maxContentLength` would REJECT an oversized
    // page. The HTML gets `HTML_INFLATION` times the text cap (timestamp spans inflate it about
    // 3-4x), and the decoded text is then cut at `maxBytes` itself.
    const res = await client.get<AsyncIterable<Uint8Array>>(
        `/${jobPath}/${buildNumber}/execution/node/${nodeId}/log/?consoleFull`,
        { responseType: "stream" }
    );

    if (res.status === 404) {
        throw new Error(`Node ${nodeId} not found on build ${buildNumber}`);
    }

    if (res.status !== 200) {
        throw new Error(`consoleFull returned ${res.status}`);
    }

    const html = await readCapped(res.data, maxBytes * HTML_INFLATION);
    const text = Buffer.from(parseConsoleFullHtml(html.raw, { cut: html.truncated }), "utf8");
    const raw = utf8Head(text, maxBytes);
    const truncated = html.truncated || text.length > maxBytes;
    let nodeStatus: string | undefined;

    // Pull nodeStatus from a cheap wfapi describe call — consoleFull doesn't include it.
    try {
        const meta = await client.get(`/${jobPath}/${buildNumber}/execution/node/${nodeId}/wfapi/describe`);
        if (meta.status === 200) {
            nodeStatus = (meta.data as { status?: string }).status;
        }
    } catch {
        // nodeStatus is non-critical; cache hits already omit it.
    }

    return { raw, nodeStatus, truncated };
}

/**
 * Whole-build log via `/consoleText`, in one request. `progressiveText` is not used: for a
 * running build it returns about 1 MB of text while `X-Text-Size` reports the full size,
 * so an offset cursor silently skips the rest of the log.
 *
 * The body is streamed and cut at `maxBytes`: axios' `maxContentLength` would REJECT a longer log
 * instead of truncating it, so a build over the cap would fail outright.
 */
async function fetchConsoleText({ client, jobPath, buildNumber, maxBytes }: LogRequest): Promise<FetchedLog> {
    const res = await client.get<AsyncIterable<Uint8Array>>(`/${jobPath}/${buildNumber}/consoleText`, {
        responseType: "stream",
    });

    if (res.status === 404) {
        throw new Error(`Build ${buildNumber} log not found (build may have been pruned by retention)`);
    }

    if (res.status !== 200) {
        throw new Error(`consoleText returned ${res.status}`);
    }

    return readCapped(res.data, maxBytes);
}

/**
 * The first `maxBytes` of a byte stream, and whether more followed. Leaving the loop early ends
 * the stream, which aborts the rest of the download.
 */
export async function readCapped(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<FetchedLog> {
    const chunks: Uint8Array[] = [];
    let size = 0;

    for await (const chunk of body) {
        chunks.push(chunk);
        size += chunk.length;

        if (size > maxBytes) {
            logger.debug(`Jenkins log cut at ${maxBytes} bytes`);
            return { raw: utf8Head(Buffer.concat(chunks), maxBytes), truncated: true };
        }
    }

    return { raw: Buffer.concat(chunks).toString("utf8"), truncated: false };
}

/**
 * At most `maxBytes` of UTF-8 text from the start of `bytes`, never ending inside a multi-byte
 * character: the cut backs off over continuation bytes (`10xxxxxx`) so no U+FFFD is left behind.
 */
export function utf8Head(bytes: Uint8Array, maxBytes: number): string {
    let end = Math.min(maxBytes, bytes.length);

    while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
        end -= 1;
    }

    return Buffer.from(bytes.buffer, bytes.byteOffset, end).toString("utf8");
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
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
    // Build a RegExp from user input; on syntax error fall back to literal substring search
    // so a malformed --grep typo doesn't crash. ReDoS via a syntactically-valid catastrophic
    // pattern is out of scope here — input comes from a local CLI/MCP, not a network boundary.
    let test: (line: string) => boolean;

    try {
        const re = new RegExp(pattern);
        test = (line) => {
            re.lastIndex = 0;
            return re.test(line);
        };
    } catch {
        test = (line) => line.includes(pattern);
    }

    const lines = content.split("\n");
    const matches: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        if (test(lines[i])) {
            matches.push(`L${i + 1}: ${lines[i].replace(/\r$/, "")}`);

            if (matches.length >= 200) {
                break;
            }
        }
    }

    return matches;
}
