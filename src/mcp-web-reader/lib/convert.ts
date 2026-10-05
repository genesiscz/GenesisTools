import { createStopwatch } from "@genesiscz/utils/format";
import { createTurndownService } from "@genesiscz/utils/markdown/html-to-md";
import type TurndownService from "turndown";
import { type ExtractionMethod, extractContent, type PageMeta } from "./extract";
import { frontMatter, normalizeMarkdown } from "./markdown";

export const DEPTHS = ["basic", "advanced"] as const;
export type Depth = (typeof DEPTHS)[number];

export const ENGINE_NAMES = ["turndown"] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

interface Engine {
    description: string;
    /** Markdown for an HTML fragment whose links and images are already absolute. */
    toMarkdown(html: string): string;
}

const ENGINES: Record<EngineName, Engine> = {
    turndown: {
        description: "Turndown with GFM tables, fenced code with language detection, and figure captions",
        toMarkdown: (html) => readerTurndown().turndown(html),
    },
};

/** Engines this tool used to ship, and why each one is gone. An old config naming one gets told so. */
const REMOVED_ENGINES = new Map([
    ["mdream", "it needed the mdream package"],
    ["readerlm", "it needed @nanocollective/get-md, which never ran the ReaderLM model here"],
]);

export function isEngineName(value: string): value is EngineName {
    return ENGINE_NAMES.some((name) => name === value);
}

export function isDepth(value: string): value is Depth {
    return DEPTHS.some((depth) => depth === value);
}

export function listEngines(): Array<{ name: EngineName; description: string }> {
    return ENGINE_NAMES.map((name) => ({ name, description: ENGINES[name].description }));
}

/** Why `name` is no engine, for a removed engine and an unknown one alike. */
export function unknownEngineMessage(name: string): string {
    const available = `Available engines: ${ENGINE_NAMES.join(", ")}.`;
    const reason = REMOVED_ENGINES.get(name);

    if (reason) {
        return `Engine "${name}" was removed (${reason}). ${available}`;
    }

    return `Unknown engine "${name}". ${available}`;
}

export function removedEngineReason(name: string): string | undefined {
    return REMOVED_ENGINES.get(name);
}

export interface ConversionResult {
    markdown: string;
    meta: PageMeta;
    method: ExtractionMethod;
    engine: EngineName;
    /** Formatted wall time of extraction plus conversion, for example "38ms". */
    conversionTime: string;
}

/** Extract the readable part of a page and turn it into markdown; `advanced` adds YAML front matter. */
export function convertHtml(
    html: string,
    options: { url: string; depth: Depth; engine: EngineName }
): ConversionResult {
    const elapsed = createStopwatch();
    const extracted = extractContent(html, options.url);
    const body = normalizeMarkdown(ENGINES[options.engine].toMarkdown(extracted.content));
    const markdown = options.depth === "advanced" ? frontMatter(extracted.meta) + body : body;

    return {
        markdown,
        meta: extracted.meta,
        method: extracted.method,
        engine: options.engine,
        conversionTime: elapsed(),
    };
}

let turndown: TurndownService | undefined;

function readerTurndown(): TurndownService {
    turndown ??= createReaderTurndown();
    return turndown;
}

function createReaderTurndown(): TurndownService {
    const service = createTurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        fence: "```",
        bulletListMarker: "-",
        emDelimiter: "*",
        strongDelimiter: "**",
    });

    service.remove(["script", "style", "noscript", "iframe", "template"]);

    service.addRule("codeBlock", {
        filter: "pre",
        replacement: (_content, node) => fencedCode(node),
    });

    service.addRule("link", {
        filter: (node) => node.nodeName === "A" && node.getAttribute("href") !== null,
        replacement: (content, node) => {
            const text = content.replace(/\s+/g, " ").trim();
            const href = node.getAttribute("href") ?? "";

            // A heading's permalink glyph ("#", "¶", "§") is not part of the heading.
            if (!text || (/^[#¶§]$/.test(text) && href.includes("#"))) {
                return "";
            }

            if (href.startsWith("#") || /^javascript:/i.test(href)) {
                return text;
            }

            return `[${text}](${href.replace(/[()]/g, "\\$&")})`;
        },
    });

    // A figure keeps whatever it holds (several images, paragraphs, a linked image); only its caption is set apart.
    service.addRule("figcaption", {
        filter: "figcaption",
        replacement: (content) => {
            const caption = content.replace(/\s+/g, " ").trim();
            return caption ? `\n*${caption}*\n\n` : "";
        },
    });

    service.addRule("inlineCode", {
        filter: (node) => node.nodeName === "CODE" && !node.closest("pre"),
        replacement: (_content, node) => {
            const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
            if (!text) {
                return "";
            }

            const fence = "`".repeat(longestBacktickRun(text) + 1);
            const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";

            return `${fence}${pad}${text}${pad}${fence}`;
        },
    });

    return service;
}

function fencedCode(pre: HTMLElement): string {
    const code = pre.querySelector("code");
    const text = codeText(code ?? pre)
        .replace(/^\n+/, "")
        .trimEnd();
    const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));

    return `\n\n${fence}${detectLanguage(pre, code)}\n${text}\n${fence}\n\n`;
}

/** The text of a code block, with `<br>` as a line break: some highlighters emit those instead of newlines. */
function codeText(node: Node): string {
    let text = "";

    for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === child.TEXT_NODE) {
            text += child.nodeValue ?? "";
        } else if (child.nodeName === "BR") {
            text += "\n";
        } else {
            text += codeText(child);
        }
    }

    return text;
}

function longestBacktickRun(text: string): number {
    return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
}

const LANGUAGE_PATTERNS = [
    /(?:^|\s)lang(?:uage)?-([\w+#-]+)/i,
    /(?:^|\s)highlight-(?:source-)?([\w+#-]+)/i,
    /brush:\s*([\w+#-]+)/i,
];

const LANGUAGE_ALIASES: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    py: "python",
    rb: "ruby",
    sh: "bash",
    yml: "yaml",
};

function detectLanguage(pre: HTMLElement, code: HTMLElement | null): string {
    // Turndown's DOM reports a missing parent as undefined, not null.
    const holders = [code, pre, pre.parentElement].filter((el): el is HTMLElement => Boolean(el));

    for (const el of holders) {
        const declared = el.getAttribute("data-language") ?? el.getAttribute("data-lang");
        if (declared) {
            return normalizeLanguage(declared);
        }
    }

    const classes = holders.map((el) => el.getAttribute("class") ?? "").join(" ");

    for (const pattern of LANGUAGE_PATTERNS) {
        const match = classes.match(pattern);
        if (match) {
            return normalizeLanguage(match[1]);
        }
    }

    return "";
}

function normalizeLanguage(language: string): string {
    const lower = language.toLowerCase();
    return LANGUAGE_ALIASES[lower] ?? lower;
}
