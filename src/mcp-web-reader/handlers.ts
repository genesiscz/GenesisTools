import axios from "axios";
import { getEngine, type EngineName } from "./engines/index.js";
import { validateMarkdown } from "./utils/validation.js";
import { limitToTokens } from "./utils/tokens.js";
import { ensureHttpUrl, buildJinaUrl } from "./utils/urls.js";

const UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
    const res = await axios.get(url, {
        responseType: "text",
        headers: {
            "User-Agent": UA,
            Accept: "*/*",
            ...headers,
        },
        timeout: 30000,
        validateStatus: (s) => s >= 200 && s < 400,
        maxRedirects: 5,
    });
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
}

export function compactCodeBlocks(markdown: string): string {
    const lines = markdown.split("\n");
    const result: string[] = [];
    let inFence = false;
    let fence = "```";
    let buffer: string[] = [];

    function flushBuffer(): void {
        const out: string[] = [];
        let lastBlank = false;
        for (let line of buffer) {
            line = line.replace(/[ \t]+$/g, "");
            const isBlank = line.trim().length === 0;
            if (isBlank) {
                if (!lastBlank) out.push("");
                lastBlank = true;
            } else {
                out.push(line);
                lastBlank = false;
            }
        }
        result.push(...out);
        buffer = [];
    }

    for (const line of lines) {
        if (!inFence && /^`{3,}/.test(line)) {
            inFence = true;
            fence = line.match(/^`{3,}/)?.[0] || "```";
            result.push(line.replace(/[ \t]+$/g, ""));
            continue;
        }
        if (inFence && line.startsWith(fence)) {
            flushBuffer();
            result.push(line.replace(/[ \t]+$/g, ""));
            inFence = false;
            continue;
        }
        if (inFence) buffer.push(line);
        else result.push(line.replace(/[ \t]+$/g, ""));
    }
    if (buffer.length) flushBuffer();
    return result.join("\n");
}

export async function handleFetchWebRaw(args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
    meta?: Record<string, string>;
}> {
    const url = ensureHttpUrl(String(args.url));
    const headers = (args.headers || undefined) as Record<string, string> | undefined;
    const saveTokens = Number(args.save_tokens) === 1;
    const maxTokens = typeof args.tokens === "number" ? (args.tokens as number) : undefined;
    let html = await fetchText(url, headers);
    if (saveTokens) html = html.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
    const limited = limitToTokens(html, maxTokens);
    return { content: [{ type: "text", text: limited.text }], meta: { tokens: String(limited.tokens) } };
}

export async function handleFetchJina(args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
    meta?: Record<string, string>;
}> {
    const url = ensureHttpUrl(String(args.url));
    const saveTokens = Number(args.save_tokens) === 1;
    const maxTokens = typeof args.tokens === "number" ? (args.tokens as number) : undefined;
    let md = await fetchText(buildJinaUrl(url));
    if (saveTokens) md = compactCodeBlocks(md);
    const limited = limitToTokens(md, maxTokens);
    return { content: [{ type: "text", text: limited.text }], meta: { tokens: String(limited.tokens) } };
}

interface FetchMarkdownArgs {
    url: string;
    headers?: Record<string, string>;
    depth?: "basic" | "advanced";
    engine?: EngineName;
    tokens?: number;
    save_tokens?: number;
}

export async function handleFetchWebMarkdown(args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
    meta?: Record<string, string>;
}> {
    const typedArgs: FetchMarkdownArgs = {
        url: String(args.url),
        headers: (args.headers || undefined) as Record<string, string> | undefined,
        depth: (args.depth as "basic" | "advanced") || "basic",
        engine: (args.engine as EngineName) || "turndown",
        tokens: typeof args.tokens === "number" ? args.tokens : undefined,
        save_tokens: typeof args.save_tokens === "number" ? args.save_tokens : undefined,
    };

    const url = ensureHttpUrl(typedArgs.url);
    const engine = getEngine(typedArgs.engine || "turndown");
    const saveTokens = Number(typedArgs.save_tokens) === 1;
    const maxTokens = typedArgs.tokens;

    // Fetch HTML
    const html = await fetchText(url, typedArgs.headers);

    // Convert using selected engine
    const result = await engine.convert(html, {
        baseUrl: url,
        depth: typedArgs.depth || "basic",
    });

    // Validate output
    const validation = validateMarkdown(result.markdown);

    // Apply save_tokens compaction
    let markdown = result.markdown;
    if (saveTokens) {
        markdown = compactCodeBlocks(markdown);
    }

    // Apply token limit
    const limited = limitToTokens(markdown, maxTokens);

    return {
        content: [{ type: "text", text: limited.text }],
        meta: {
            tokens: String(limited.tokens),
            truncated: limited.truncated ? "true" : "false",
            engine: engine.name,
            conversion_time_ms: String(Math.round(result.metrics.conversionTimeMs)),
            validation_valid: validation.valid ? "true" : "false",
            ...(validation.issues.length > 0 ? { validation_issues: validation.issues.join("; ") } : {}),
        },
    };
}
