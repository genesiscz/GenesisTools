import { convertHtml, type Depth } from "@app/mcp-web-reader/lib/convert";
import { compactCodeBlocks, compactWhitespace, validateMarkdown } from "@app/mcp-web-reader/lib/markdown";
import { ensureHttpUrl } from "@app/mcp-web-reader/lib/urls";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { limitToTokens } from "@genesiscz/utils/tokens";
import { describeVerdict } from "./challenge";
import type { Fetcher } from "./fetcher";
import { extractJsonLd, type JsonLdData } from "./jsonld";
import type { Escalation, FetchMode, TransportChoice, TransportName } from "./types";

const { log } = logger.scoped("fetch");

export interface FetchRequest {
    url: string;
    mode: FetchMode;
    /** Default `auto`. */
    transport?: TransportChoice;
    headers?: Record<string, string>;
    /** Markdown mode: `advanced` adds YAML front matter. */
    depth?: Depth;
    /** Markdown and raw mode. JSON-LD output is never cut, so it stays valid JSON. */
    maxTokens?: number;
    /** Compact whitespace (raw) or code blocks (markdown). */
    saveTokens?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface FetchResult {
    mode: FetchMode;
    /** Markdown, raw HTML, or the JSON-LD document as JSON text. */
    text: string;
    tokens: number;
    truncated: boolean;
    /** The address after redirects. */
    source: string;
    status: number;
    transport: TransportName;
    escalation?: Escalation;
    /** Markdown mode. */
    conversion?: { method: string; conversionTime: string; issues: string[] };
    /** JSON-LD mode. */
    jsonld?: JsonLdData;
}

/** The JSON document jsonld mode returns: where it came from, then the extraction. */
export interface JsonLdDocument extends JsonLdData {
    url: string;
    transport: TransportName;
    escalatedFrom?: TransportName;
}

/** Names the transport that answered, and why `auto` escalated: "chrome, escalated after plain got a Cloudflare …". */
export function describeTransport(result: Pick<FetchResult, "transport" | "escalation">): string {
    const { escalation } = result;
    if (!escalation) {
        return result.transport;
    }

    return `${result.transport}, escalated after ${escalation.from} got ${describeVerdict(escalation.reason, escalation.status)}`;
}

/** The one read operation behind the CLI and both MCP doors: fetch through the chosen transport, then render per mode. */
export async function fetchUrl(fetcher: Fetcher, request: FetchRequest): Promise<FetchResult> {
    const url = ensureHttpUrl(request.url);
    const transport = request.transport ?? "auto";
    const page = await fetcher.get({
        url,
        transport,
        headers: request.headers,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
    });
    const base = { source: page.url, status: page.status, transport: page.transport, escalation: page.escalation };

    log.debug(
        {
            url,
            final: page.url,
            mode: request.mode,
            transport: page.transport,
            escalated: page.escalation !== undefined,
        },
        "fetch: page received"
    );

    if (request.mode === "raw") {
        const html = request.saveTokens ? compactWhitespace(page.body) : page.body;
        return { mode: "raw", ...base, ...limitToTokens(html, request.maxTokens) };
    }

    if (request.mode === "jsonld") {
        const jsonld = extractJsonLd(page.body);
        const document: JsonLdDocument = {
            url: page.url,
            transport: page.transport,
            ...(page.escalation ? { escalatedFrom: page.escalation.from } : {}),
            ...jsonld,
        };
        log.debug(
            { url: page.url, blocks: jsonld.blocks, products: jsonld.products.length, parseErrors: jsonld.parseErrors },
            "fetch: JSON-LD extracted"
        );
        return { mode: "jsonld", ...base, ...limitToTokens(SafeJSON.stringify(document, null, 2)), jsonld };
    }

    const converted = convertHtml(page.body, { url: page.url, depth: request.depth ?? "basic", engine: "turndown" });
    const issues = validateMarkdown(converted.markdown);
    const markdown = request.saveTokens ? compactCodeBlocks(converted.markdown) : converted.markdown;
    return {
        mode: "markdown",
        ...base,
        ...limitToTokens(markdown, request.maxTokens),
        conversion: { method: converted.method, conversionTime: converted.conversionTime, issues },
    };
}
