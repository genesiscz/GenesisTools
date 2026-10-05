import { logger } from "@genesiscz/utils/logger";
import { limitToTokens } from "@genesiscz/utils/tokens";
import { convertHtml, type Depth, type EngineName } from "./convert";
import type { ExtractionMethod } from "./extract";
import { fetchPage } from "./fetch";
import { compactCodeBlocks, compactWhitespace, validateMarkdown } from "./markdown";
import { buildJinaUrl, ensureHttpUrl } from "./urls";

export const READ_MODES = ["markdown", "raw", "jina"] as const;
export type ReadMode = (typeof READ_MODES)[number];

export function isReadMode(value: string): value is ReadMode {
    return READ_MODES.some((mode) => mode === value);
}

export interface ReadOptions {
    url: string;
    mode: ReadMode;
    /** Markdown mode only. */
    engine?: EngineName;
    /** Markdown mode only: `advanced` adds YAML front matter. */
    depth?: Depth;
    /** Sent with the page request in raw and markdown mode. Never sent to Jina. */
    headers?: Record<string, string>;
    maxTokens?: number;
    /** Compact whitespace (raw) or code blocks (markdown, jina). */
    saveTokens?: boolean;
    signal?: AbortSignal;
}

export interface ReadResult {
    text: string;
    tokens: number;
    truncated: boolean;
    /** The address actually fetched, after redirects: the page, or its Jina Reader URL. */
    source: string;
    /** Set in markdown mode. */
    conversion?: {
        engine: EngineName;
        method: ExtractionMethod;
        conversionTime: string;
        issues: string[];
    };
}

/**
 * Jina sits behind a bot challenge that answers a browser User-Agent from a script with 403 (checked
 * 2026-10-05), so the Jina request names this tool instead.
 */
const JINA_HEADERS = { "User-Agent": "GenesisTools-mcp-web-reader" };

/** The one read path behind the CLI and every MCP tool: fetch, convert per mode, compact, cap the tokens. */
export async function readPage(options: ReadOptions): Promise<ReadResult> {
    const url = ensureHttpUrl(options.url);
    logger.debug({ url, mode: options.mode, engine: options.engine, depth: options.depth }, "mcp-web-reader read");

    if (options.mode === "raw") {
        const page = await fetchPage(url, { headers: options.headers, signal: options.signal });
        const html = options.saveTokens ? compactWhitespace(page.body) : page.body;
        return { ...limitToTokens(html, options.maxTokens), source: page.url };
    }

    if (options.mode === "jina") {
        const page = await fetchPage(buildJinaUrl(url), { headers: JINA_HEADERS, signal: options.signal });
        const markdown = options.saveTokens ? compactCodeBlocks(page.body) : page.body;
        return { ...limitToTokens(markdown, options.maxTokens), source: page.url };
    }

    const page = await fetchPage(url, { headers: options.headers, signal: options.signal });
    const converted = convertHtml(page.body, {
        url: page.url,
        depth: options.depth ?? "basic",
        engine: options.engine ?? "turndown",
    });
    const issues = validateMarkdown(converted.markdown);
    const markdown = options.saveTokens ? compactCodeBlocks(converted.markdown) : converted.markdown;
    const limited = limitToTokens(markdown, options.maxTokens);

    logger.debug(
        { url: page.url, method: converted.method, tokens: limited.tokens, truncated: limited.truncated, issues },
        "mcp-web-reader converted"
    );

    return {
        ...limited,
        source: page.url,
        conversion: {
            engine: converted.engine,
            method: converted.method,
            conversionTime: converted.conversionTime,
            issues,
        },
    };
}
