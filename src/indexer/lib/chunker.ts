import { extname } from "node:path";
import { SafeJSON } from "@app/utils/json";
import type { SgNode } from "@ast-grep/napi";
import { Lang, parse } from "@ast-grep/napi";
import type { ChunkRecord } from "./types";

export interface ChunkResult {
    chunks: ChunkRecord[];
    language: string | null;
    parser: "ast" | "line" | "heading" | "message" | "json";
}

// ─── Extension → Lang mapping ───────────────────────────────────
const EXT_TO_LANG: Record<string, Lang> = {
    ".ts": Lang.TypeScript,
    ".tsx": Lang.Tsx,
    ".js": Lang.JavaScript,
    ".jsx": Lang.Tsx,
    ".mjs": Lang.JavaScript,
    ".cjs": Lang.JavaScript,
    ".mts": Lang.TypeScript,
    ".cts": Lang.TypeScript,
    ".html": Lang.Html,
    ".htm": Lang.Html,
    ".css": Lang.Css,
};

const EXT_TO_LANGUAGE_NAME: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".md": "markdown",
    ".json": "json",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
};

// ─── AST node kinds to extract per language ─────────────────────
const AST_KINDS: Record<string, string[]> = {
    TypeScript: [
        "function_declaration",
        "arrow_function",
        "class_declaration",
        "method_definition",
        "interface_declaration",
        "type_alias_declaration",
        "export_statement",
    ],
    Tsx: [
        "function_declaration",
        "arrow_function",
        "class_declaration",
        "method_definition",
        "interface_declaration",
        "type_alias_declaration",
        "export_statement",
    ],
    JavaScript: [
        "function_declaration",
        "arrow_function",
        "class_declaration",
        "method_definition",
        "export_statement",
    ],
    Html: ["element", "script_element", "style_element"],
    Css: ["rule_set", "media_statement", "keyframes_statement"],
};

// ─── Rough token estimator (1 token ~ 4 chars) ─────────────────
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

// ─── SHA-256 hash using Bun.CryptoHasher ────────────────────────
function sha256(content: string): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    return hasher.digest("hex");
}

// ─── Split a chunk at line boundaries when it exceeds maxTokens ─
function splitChunkByLines(opts: {
    content: string;
    filePath: string;
    startLine: number;
    kind: string;
    name?: string;
    language?: string;
    parentChunkId?: string;
    maxTokens: number;
}): ChunkRecord[] {
    const { content, filePath, startLine, kind, name, language, parentChunkId, maxTokens } = opts;

    if (estimateTokens(content) <= maxTokens) {
        const lines = content.split("\n");
        return [
            {
                id: sha256(content),
                filePath,
                startLine,
                endLine: startLine + lines.length - 1,
                content,
                kind,
                name,
                language,
                parentChunkId,
            },
        ];
    }

    const lines = content.split("\n");
    const chunks: ChunkRecord[] = [];
    let currentLines: string[] = [];
    let currentStartLine = startLine;

    for (let i = 0; i < lines.length; i++) {
        currentLines.push(lines[i]);
        const joined = currentLines.join("\n");

        if (estimateTokens(joined) >= maxTokens || i === lines.length - 1) {
            const chunkContent = currentLines.join("\n");

            if (chunkContent.trim().length > 0) {
                chunks.push({
                    id: sha256(chunkContent),
                    filePath,
                    startLine: currentStartLine,
                    endLine: currentStartLine + currentLines.length - 1,
                    content: chunkContent,
                    kind,
                    name: name ? `${name} (part ${chunks.length + 1})` : undefined,
                    language,
                    parentChunkId,
                });
            }

            currentLines = [];
            currentStartLine = startLine + i + 1;
        }
    }

    return chunks;
}

// ─── Try to extract a name from an AST node ─────────────────────
function extractNodeName(node: SgNode): string | undefined {
    // Try the "name" field first (works for function_declaration, class_declaration, etc.)
    const nameNode = node.field("name" as never);

    if (nameNode) {
        return (nameNode as SgNode).text();
    }

    // For export_statement, try to find the name inside the declaration
    if (node.kind() === "export_statement") {
        const decl = node.field("declaration" as never);

        if (decl) {
            const innerName = (decl as SgNode).field("name" as never);

            if (innerName) {
                return (innerName as SgNode).text();
            }
        }
    }

    return undefined;
}

// ─── AST strategy ───────────────────────────────────────────────
function chunkByAst(opts: { filePath: string; content: string; maxTokens: number }): ChunkResult | null {
    const { filePath, content, maxTokens } = opts;
    const ext = extname(filePath).toLowerCase();
    const lang = EXT_TO_LANG[ext];

    if (!lang) {
        return null;
    }

    const language = EXT_TO_LANGUAGE_NAME[ext] ?? null;
    const kindList = AST_KINDS[lang] ?? [];
    const root = parse(lang, content).root();
    const seen = new Set<number>();
    const chunks: ChunkRecord[] = [];

    // Track class chunks for parent-child relationships
    const classChunkIds = new Map<number, string>();

    for (const kindName of kindList) {
        const nodes = root.findAll({ rule: { kind: kindName } });

        for (const node of nodes) {
            const nodeId = node.id();

            if (seen.has(nodeId)) {
                continue;
            }

            seen.add(nodeId);

            const text = node.text();
            const startLine = node.range().start.line;
            const name = extractNodeName(node);
            const kind = kindName;

            // Determine parent chunk id for methods inside classes
            let parentChunkId: string | undefined;

            if (kind === "method_definition") {
                const parent = node.parent();

                if (parent) {
                    const grandparent = parent.parent();

                    if (grandparent) {
                        const gpId = grandparent.id();
                        parentChunkId = classChunkIds.get(gpId);
                    }
                }
            }

            const subChunks = splitChunkByLines({
                content: text,
                filePath,
                startLine,
                kind,
                name,
                language: language ?? undefined,
                parentChunkId,
                maxTokens,
            });

            // If this is a class, store its chunk ID for child method lookups
            if (kind === "class_declaration" && subChunks.length > 0) {
                classChunkIds.set(nodeId, subChunks[0].id);
            }

            chunks.push(...subChunks);
        }
    }

    // Sort by line position
    chunks.sort((a, b) => a.startLine - b.startLine);

    // Deduplicate: export_statement may contain function_declaration etc.
    const deduped = deduplicateChunks(chunks);

    return { chunks: deduped, language, parser: "ast" };
}

// ─── Remove chunks fully contained within another chunk ─────────
function deduplicateChunks(chunks: ChunkRecord[]): ChunkRecord[] {
    if (chunks.length <= 1) {
        return chunks;
    }

    const result: ChunkRecord[] = [];

    for (const chunk of chunks) {
        // Check if this chunk is fully contained within any other chunk
        const isContained = chunks.some(
            (other) =>
                other.id !== chunk.id &&
                other.startLine <= chunk.startLine &&
                other.endLine >= chunk.endLine &&
                other.content.includes(chunk.content) &&
                other.content !== chunk.content
        );

        if (!isContained) {
            result.push(chunk);
        }
    }

    return result;
}

// ─── Line strategy ──────────────────────────────────────────────
function chunkByLine(opts: { filePath: string; content: string; maxTokens: number }): ChunkResult {
    const { filePath, content, maxTokens } = opts;
    const ext = extname(filePath).toLowerCase();
    const language = EXT_TO_LANGUAGE_NAME[ext] ?? null;

    // Split at double newlines (paragraph boundaries)
    const blocks = content.split(/\n\n+/);
    const chunks: ChunkRecord[] = [];
    let currentBlocks: string[] = [];
    let currentStartLine = 0;
    let lineOffset = 0;

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const blockLines = block.split("\n").length;

        currentBlocks.push(block);
        const merged = currentBlocks.join("\n\n");

        if (estimateTokens(merged) >= maxTokens || i === blocks.length - 1) {
            const chunkContent = currentBlocks.join("\n\n");

            if (chunkContent.trim().length > 0) {
                const chunkLines = chunkContent.split("\n").length;
                chunks.push({
                    id: sha256(chunkContent),
                    filePath,
                    startLine: currentStartLine,
                    endLine: currentStartLine + chunkLines - 1,
                    content: chunkContent,
                    kind: "line_chunk",
                    language: language ?? undefined,
                });
            }

            currentBlocks = [];
            // Account for the double newline separator (2 lines)
            currentStartLine = lineOffset + blockLines + 1;
        }

        lineOffset += blockLines + 1; // +1 for the blank line between blocks
    }

    return { chunks, language, parser: "line" };
}

// ─── Heading strategy (markdown) ────────────────────────────────
function chunkByHeading(opts: { filePath: string; content: string; maxTokens: number }): ChunkResult {
    const { filePath, content, maxTokens } = opts;
    const lines = content.split("\n");
    const chunks: ChunkRecord[] = [];
    let currentLines: string[] = [];
    let currentName: string | undefined;
    let currentStartLine = 0;

    function flushSection(): void {
        if (currentLines.length === 0) {
            return;
        }

        const sectionContent = currentLines.join("\n");

        if (sectionContent.trim().length === 0) {
            return;
        }

        const subChunks = splitChunkByLines({
            content: sectionContent,
            filePath,
            startLine: currentStartLine,
            kind: "heading",
            name: currentName,
            language: "markdown",
            maxTokens,
        });

        chunks.push(...subChunks);
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

        if (headingMatch) {
            flushSection();
            currentLines = [line];
            currentName = headingMatch[2].trim();
            currentStartLine = i;
        } else {
            currentLines.push(line);
        }
    }

    flushSection();

    return { chunks, language: "markdown", parser: "heading" };
}

// ─── Message strategy (email/chat) ──────────────────────────────
function chunkByMessage(opts: { filePath: string; content: string; maxTokens: number }): ChunkResult {
    const { filePath, content, maxTokens } = opts;

    // Try to detect message boundaries:
    // Email: "From: " or "Subject: " at start of line
    // Chat: lines starting with a name/timestamp pattern
    const messagePattern = /^(?:From:|Subject:|Date:|Message-ID:)/m;

    if (messagePattern.test(content)) {
        return chunkEmailMessages({ filePath, content, maxTokens });
    }

    // Fallback: each line or block is a message
    return chunkChatMessages({ filePath, content, maxTokens });
}

function chunkEmailMessages(opts: { filePath: string; content: string; maxTokens: number }): ChunkResult {
    const { filePath, content, maxTokens } = opts;

    // Split by email boundaries (From: or Subject: at start of line after blank line)
    const parts = content.split(/\n(?=From:|Subject:)/);
    const chunks: ChunkRecord[] = [];
    let lineOffset = 0;

    for (const part of parts) {
        const trimmed = part.trim();

        if (trimmed.length === 0) {
            lineOffset += part.split("\n").length;
            continue;
        }

        // Extract subject for the chunk name
        const subjectMatch = trimmed.match(/Subject:\s*(.+)/);
        const name = subjectMatch ? subjectMatch[1].trim() : trimmed.split("\n")[0];

        const subChunks = splitChunkByLines({
            content: trimmed,
            filePath,
            startLine: lineOffset,
            kind: "message",
            name,
            maxTokens,
        });

        chunks.push(...subChunks);
        lineOffset += part.split("\n").length;
    }

    return { chunks, language: null, parser: "message" };
}

function chunkChatMessages(opts: { filePath: string; content: string; maxTokens: number }): ChunkResult {
    const { filePath, content, maxTokens } = opts;
    const lines = content.split("\n");
    const chunks: ChunkRecord[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.length === 0) {
            continue;
        }

        const subChunks = splitChunkByLines({
            content: line,
            filePath,
            startLine: i,
            kind: "message",
            name: line.slice(0, 80),
            maxTokens,
        });

        chunks.push(...subChunks);
    }

    return { chunks, language: null, parser: "message" };
}

// ─── JSON strategy ──────────────────────────────────────────────
function chunkByJson(opts: { filePath: string; content: string; maxTokens: number }): ChunkResult {
    const { filePath, content, maxTokens } = opts;

    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(content, { strict: true });
    } catch {
        // Not valid JSON, fall back to line chunking
        return chunkByLine({ filePath, content, maxTokens });
    }

    const chunks: ChunkRecord[] = [];

    if (Array.isArray(parsed)) {
        for (let i = 0; i < parsed.length; i++) {
            const elemContent = SafeJSON.stringify(parsed[i], null, 2);
            const subChunks = splitChunkByLines({
                content: elemContent,
                filePath,
                startLine: i,
                kind: "json_element",
                name: `[${i}]`,
                language: "json",
                maxTokens,
            });
            chunks.push(...subChunks);
        }
    } else if (parsed !== null && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const keys = Object.keys(obj);

        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const valContent = SafeJSON.stringify(obj[key], null, 2);
            const chunkContent = `"${key}": ${valContent}`;
            const subChunks = splitChunkByLines({
                content: chunkContent,
                filePath,
                startLine: i,
                kind: "json_key",
                name: key,
                language: "json",
                maxTokens,
            });
            chunks.push(...subChunks);
        }
    } else {
        // Primitive value, single chunk
        const stringified = SafeJSON.stringify(parsed, null, 2);
        chunks.push({
            id: sha256(stringified),
            filePath,
            startLine: 0,
            endLine: 0,
            content: stringified,
            kind: "json_value",
            language: "json",
        });
    }

    return { chunks, language: "json", parser: "json" };
}

// ─── Auto strategy ──────────────────────────────────────────────
function selectAutoStrategy(opts: {
    filePath: string;
    indexType?: "code" | "files" | "mail" | "chat";
}): "ast" | "line" | "heading" | "message" | "json" {
    const { filePath, indexType } = opts;

    if (indexType === "mail" || indexType === "chat") {
        return "message";
    }

    const ext = extname(filePath).toLowerCase();

    if (ext === ".md" || ext === ".markdown") {
        return "heading";
    }

    if (ext === ".json" || ext === ".jsonl") {
        return "json";
    }

    if (EXT_TO_LANG[ext]) {
        return "ast";
    }

    return "line";
}

// ─── Main entry point ───────────────────────────────────────────
export function chunkFile(opts: {
    filePath: string;
    content: string;
    strategy: "ast" | "line" | "heading" | "message" | "json" | "auto";
    maxTokens?: number;
    indexType?: "code" | "files" | "mail" | "chat";
}): ChunkResult {
    const { filePath, content, strategy, indexType } = opts;
    const maxTokens = opts.maxTokens ?? 500;

    const effectiveStrategy = strategy === "auto" ? selectAutoStrategy({ filePath, indexType }) : strategy;

    switch (effectiveStrategy) {
        case "ast": {
            const result = chunkByAst({ filePath, content, maxTokens });

            if (result) {
                return result;
            }

            // Fallback to line for unsupported languages
            return chunkByLine({ filePath, content, maxTokens });
        }

        case "heading":
            return chunkByHeading({ filePath, content, maxTokens });

        case "message":
            return chunkByMessage({ filePath, content, maxTokens });

        case "json":
            return chunkByJson({ filePath, content, maxTokens });

        default:
            return chunkByLine({ filePath, content, maxTokens });
    }
}
