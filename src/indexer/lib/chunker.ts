import { extname } from "node:path";
import { xxhash } from "@app/utils/hash";
import { SafeJSON } from "@app/utils/json";
import { estimateTokens } from "@app/utils/tokens";
import type { SgNode } from "@ast-grep/napi";
import { type Lang, parse } from "@ast-grep/napi";
import { EXT_TO_DYNAMIC_LANG, EXT_TO_LANG, EXT_TO_LANGUAGE_NAME, ensureDynamicLanguages } from "./ast-languages";
import type { ChunkRecord } from "./types";

export interface ChunkResult {
    chunks: ChunkRecord[];
    language: string | null;
    parser: "ast" | "line" | "heading" | "message" | "json" | "character";
}

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
    python: ["function_definition", "class_definition", "decorated_definition"],
    go: ["function_declaration", "method_declaration", "type_declaration"],
    rust: ["function_item", "impl_item", "struct_item", "enum_item", "trait_item"],
    java: ["class_declaration", "method_declaration", "interface_declaration", "enum_declaration"],
    c: ["function_definition", "struct_specifier", "enum_specifier", "declaration"],
    cpp: ["function_definition", "class_specifier", "struct_specifier", "namespace_definition", "declaration"],
    ruby: ["method", "class", "module", "singleton_method"],
    php: ["function_definition", "class_declaration", "method_declaration", "trait_declaration"],
    swift: ["function_declaration", "class_declaration", "protocol_declaration"],
    kotlin: ["class_declaration", "function_declaration", "object_declaration"],
    scala: ["class_definition", "object_definition", "trait_definition", "function_definition"],
    csharp: ["class_declaration", "interface_declaration", "method_declaration", "namespace_declaration"],
};

/** Hard character cap per chunk — universal safety net applied to ALL strategies */
const MAX_CHUNK_CHARS = 2000;

// ─── Universal safety net: cap all chunks at MAX_CHUNK_CHARS ────
/**
 * Truncate any chunk exceeding MAX_CHUNK_CHARS.
 * Tries to truncate at the last safe boundary (newline > space > semicolon).
 * If no safe boundary is found, hard-truncates at the limit.
 */
function applyCharCap(chunks: ChunkRecord[]): ChunkRecord[] {
    if (chunks.every((c) => c.content.length <= MAX_CHUNK_CHARS)) {
        return chunks;
    }

    const result: ChunkRecord[] = [];

    for (const chunk of chunks) {
        if (chunk.content.length <= MAX_CHUNK_CHARS) {
            result.push(chunk);
            continue;
        }

        // Re-split oversized chunks using character-based splitting to preserve all content
        const subResult = chunkByCharacter({ filePath: chunk.filePath, content: chunk.content });

        for (const sub of subResult.chunks) {
            result.push({
                ...sub,
                kind: chunk.kind,
                name: chunk.name ? `${chunk.name} (part ${result.length + 1})` : undefined,
                language: chunk.language ?? sub.language,
                parentChunkId: chunk.parentChunkId,
                startLine: chunk.startLine + sub.startLine,
                endLine: chunk.startLine + sub.endLine,
            });
        }
    }

    return result;
}

/** Average line length threshold for minified/bundled file detection */
const MAX_AVG_LINE_LENGTH = 500;

/** Detect minified/bundled content by average line length */
function isMinified(content: string): boolean {
    const lines = content.split("\n");

    if (lines.length === 0) {
        return false;
    }

    const avgLineLength = content.length / lines.length;
    return avgLineLength > MAX_AVG_LINE_LENGTH;
}

// ─── Character-based chunking for minified/bundled content ──────
/**
 * Splits at safe boundaries: newline > space > tab > semicolon > comma.
 * Uses byte offset for chunk IDs since line numbers are meaningless for minified files.
 */
function chunkByCharacter(opts: { filePath: string; content: string }): ChunkResult {
    const { filePath, content } = opts;
    const ext = extname(filePath).toLowerCase();
    const language = EXT_TO_LANGUAGE_NAME[ext] ?? null;
    const chunks: ChunkRecord[] = [];
    let offset = 0;
    let currentLine = 0;

    while (offset < content.length) {
        let end = Math.min(offset + MAX_CHUNK_CHARS, content.length);

        // Scan backwards to find a safe split boundary
        if (end < content.length) {
            const breakChars = ["\n", " ", "\t", ";", ","];

            for (let i = end - 1; i > offset; i--) {
                if (breakChars.includes(content[i])) {
                    end = i + 1;
                    break;
                }
            }
        }

        const chunkContent = content.slice(offset, end);
        const newlineCount = (chunkContent.match(/\n/g) ?? []).length;
        const startLine = currentLine;
        const endLine = currentLine + newlineCount;

        if (chunkContent.trim().length > 0) {
            chunks.push({
                id: xxhash(chunkContent),
                filePath,
                startLine,
                endLine,
                content: chunkContent,
                kind: "character_chunk",
                language: language ?? undefined,
            });
        }

        currentLine = chunkContent.endsWith("\n") ? endLine + 1 : endLine;
        offset = end;
    }

    return { chunks, language, parser: "character" };
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
    overlap?: number;
}): ChunkRecord[] {
    const { content, filePath, startLine, kind, name, language, parentChunkId, maxTokens } = opts;
    const overlap = opts.overlap ?? 0;

    if (estimateTokens(content) <= maxTokens) {
        const lines = content.split("\n");
        return [
            {
                id: xxhash(content),
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
                    id: xxhash(chunkContent),
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

            // Carry over `overlap` lines from the end of the flushed chunk
            const overlapLines = chunkContent.split("\n").slice(-overlap);
            currentLines = overlap > 0 ? [...overlapLines] : [];
            currentStartLine = startLine + i + 1 - (overlap > 0 ? overlapLines.length : 0);
        }
    }

    return chunks;
}

// ─── Safe field access wrapper for SgNode ────────────────────────
/**
 * Access a named field on an SgNode. The ast-grep field() API accepts
 * string field names but the TS signature is restrictive, so we funnel
 * all accesses through this helper to avoid scattered casts.
 */
function getNodeField(node: SgNode, fieldName: string): SgNode | null {
    type FieldAccessor = (name: string) => SgNode | null;
    return (node.field as FieldAccessor)(fieldName);
}

// ─── Try to extract a name from an AST node ─────────────────────
function extractNodeName(node: SgNode): string | undefined {
    // Try the "name" field first (works for function_declaration, class_declaration, etc.)
    const nameNode = getNodeField(node, "name");

    if (nameNode) {
        return nameNode.text();
    }

    // For export_statement, try to find the name inside the declaration
    if (node.kind() === "export_statement") {
        const decl = getNodeField(node, "declaration");

        if (decl) {
            const innerName = getNodeField(decl, "name");

            if (innerName) {
                return innerName.text();
            }
        }
    }

    return undefined;
}

/** Minimum lines for an AST chunk to stand on its own (otherwise merge with neighbors) */
const MIN_AST_CHUNK_LINES = 5;

/** Maximum lines for a single AST declaration before sub-chunking */
const MAX_AST_CHUNK_LINES = 150;

// ─── Sub-chunk large AST declarations ───────────────────────────
/**
 * Sub-chunk a large AST declaration (>MAX_AST_CHUNK_LINES lines).
 * Preserves the declaration header (first 2 lines) as context in each sub-chunk.
 * Uses line-count-based splitting with overlap.
 */
function subChunkLargeNode(opts: {
    content: string;
    filePath: string;
    startLine: number;
    kind: string;
    name?: string;
    language?: string;
    parentChunkId?: string;
    chunkSize: number;
    overlap: number;
}): ChunkRecord[] {
    const { content, filePath, startLine, kind, name, language, parentChunkId, chunkSize, overlap } = opts;

    const lines = content.split("\n");

    if (lines.length <= MAX_AST_CHUNK_LINES) {
        return [
            {
                id: xxhash(content),
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

    const headerLineCount = Math.min(2, lines.length);
    const header = lines.slice(0, headerLineCount).join("\n");
    const bodyLines = lines.slice(headerLineCount);
    const chunks: ChunkRecord[] = [];
    const step = Math.max(1, chunkSize - overlap);

    for (let i = 0; i < bodyLines.length; i += step) {
        const end = Math.min(i + chunkSize, bodyLines.length);
        const chunkBodyLines = bodyLines.slice(i, end);
        const isFirst = i === 0;
        const chunkContent = isFirst
            ? lines.slice(0, headerLineCount + end).join("\n")
            : `${header}\n${chunkBodyLines.join("\n")}`;

        const chunkStartLine = isFirst ? startLine : startLine + headerLineCount + i;

        chunks.push({
            id: xxhash(chunkContent),
            filePath,
            startLine: chunkStartLine,
            endLine: startLine + headerLineCount + end - 1,
            content: chunkContent,
            kind,
            name: name ? `${name} (part ${chunks.length + 1})` : undefined,
            language,
            parentChunkId,
        });

        if (end >= bodyLines.length) {
            break;
        }
    }

    return chunks;
}

// ─── Merge consecutive small AST chunks ─────────────────────────
/**
 * Merge consecutive small AST chunks into larger combined chunks.
 * A chunk is "small" if it has fewer than MIN_AST_CHUNK_LINES lines.
 * Merging continues until the combined chunk reaches maxTokens or MAX_CHUNK_CHARS.
 */
function mergeSmallChunks(opts: { chunks: ChunkRecord[]; maxTokens: number }): ChunkRecord[] {
    const { chunks, maxTokens } = opts;

    if (chunks.length <= 1) {
        return chunks;
    }

    const result: ChunkRecord[] = [];
    let pending: ChunkRecord[] = [];

    function flushPending(): void {
        if (pending.length === 0) {
            return;
        }

        if (pending.length === 1) {
            result.push(pending[0]);
            pending = [];
            return;
        }

        // Merge all pending chunks into one
        const mergedContent = pending.map((c) => c.content).join("\n\n");
        const mergedNames = pending
            .map((c) => c.name)
            .filter(Boolean)
            .join(", ");

        result.push({
            id: xxhash(mergedContent),
            filePath: pending[0].filePath,
            startLine: pending[0].startLine,
            endLine: pending[pending.length - 1].endLine,
            content: mergedContent,
            kind: "merged_declarations",
            name: mergedNames || undefined,
            language: pending[0].language,
        });

        pending = [];
    }

    for (const chunk of chunks) {
        const chunkLineCount = chunk.content.split("\n").length;
        const isSmall = chunkLineCount < MIN_AST_CHUNK_LINES;

        if (!isSmall) {
            flushPending();
            result.push(chunk);
            continue;
        }

        // Check if adding this chunk to pending would exceed limits
        if (pending.length > 0) {
            const pendingContent = pending.map((c) => c.content).join("\n\n");
            const combinedContent = `${pendingContent}\n\n${chunk.content}`;

            if (estimateTokens(combinedContent) > maxTokens || combinedContent.length > MAX_CHUNK_CHARS) {
                flushPending();
            }
        }

        pending.push(chunk);
    }

    flushPending();

    return result;
}

// ─── AST strategy ───────────────────────────────────────────────
async function chunkByAst(opts: {
    filePath: string;
    content: string;
    maxTokens: number;
    overlap: number;
}): Promise<ChunkResult | null> {
    const { filePath, content, maxTokens } = opts;
    const ext = extname(filePath).toLowerCase();

    // Try built-in Lang first
    let lang: Lang | string | undefined = EXT_TO_LANG[ext];
    let isDynamic = false;

    if (!lang) {
        // Try dynamic language
        const dynamicLang = EXT_TO_DYNAMIC_LANG[ext];

        if (!dynamicLang) {
            return null;
        }

        await ensureDynamicLanguages({ only: [dynamicLang] });
        lang = dynamicLang;
        isDynamic = true;
    }

    const language = EXT_TO_LANGUAGE_NAME[ext] ?? null;
    const kindList = AST_KINDS[isDynamic ? (lang as string) : String(lang)] ?? [];
    const root = parse(lang as Lang, content).root();
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

            const nodeLines = text.split("\n").length;

            let subChunks: ChunkRecord[];

            if (nodeLines > MAX_AST_CHUNK_LINES) {
                subChunks = subChunkLargeNode({
                    content: text,
                    filePath,
                    startLine,
                    kind,
                    name,
                    language: language ?? undefined,
                    parentChunkId,
                    chunkSize: 100,
                    overlap: opts.overlap,
                });
            } else {
                subChunks = splitChunkByLines({
                    content: text,
                    filePath,
                    startLine,
                    kind,
                    name,
                    language: language ?? undefined,
                    parentChunkId,
                    maxTokens,
                    overlap: opts.overlap,
                });
            }

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

    // Merge small adjacent declarations
    const merged = mergeSmallChunks({ chunks: deduped, maxTokens });

    return { chunks: merged, language, parser: "ast" };
}

// ─── Remove chunks fully contained within another chunk ─────────
function deduplicateChunks(chunks: ChunkRecord[]): ChunkRecord[] {
    if (chunks.length <= 1) {
        return chunks;
    }

    const result: ChunkRecord[] = [];

    for (const chunk of chunks) {
        // Check if this chunk's line range is fully contained within any other chunk
        const isContained = chunks.some(
            (other) =>
                other.id !== chunk.id &&
                other.startLine <= chunk.startLine &&
                other.endLine >= chunk.endLine &&
                other.content.length > chunk.content.length
        );

        if (!isContained) {
            result.push(chunk);
        }
    }

    return result;
}

// ─── Line strategy ──────────────────────────────────────────────
function chunkByLine(opts: { filePath: string; content: string; maxTokens: number; overlap: number }): ChunkResult {
    const { filePath, content, maxTokens, overlap } = opts;
    const ext = extname(filePath).toLowerCase();
    const language = EXT_TO_LANGUAGE_NAME[ext] ?? null;
    const lines = content.split("\n");
    const chunks: ChunkRecord[] = [];
    let currentLines: string[] = [];
    let currentStartLine = 0;

    for (let i = 0; i < lines.length; i++) {
        currentLines.push(lines[i]);
        const joined = currentLines.join("\n");

        if (estimateTokens(joined) >= maxTokens || i === lines.length - 1) {
            const chunkContent = currentLines.join("\n");

            if (chunkContent.trim().length > 0) {
                chunks.push({
                    id: xxhash(chunkContent),
                    filePath,
                    startLine: currentStartLine,
                    endLine: currentStartLine + currentLines.length - 1,
                    content: chunkContent,
                    kind: "line_chunk",
                    language: language ?? undefined,
                });
            }

            // Carry over overlap lines from the end of the flushed chunk
            const overlapLines = chunkContent.split("\n").slice(-overlap);
            currentLines = overlap > 0 ? [...overlapLines] : [];
            currentStartLine = i + 1 - (overlap > 0 ? overlapLines.length : 0);
        }
    }

    return { chunks, language, parser: "line" };
}

// ─── Split content by paragraph boundaries ──────────────────────
function splitByParagraphs(opts: {
    content: string;
    filePath: string;
    startLine: number;
    kind: string;
    name?: string;
    language?: string;
    headingLine?: string;
    maxTokens: number;
}): ChunkRecord[] {
    const { content, filePath, startLine, kind, name, language, headingLine, maxTokens } = opts;

    const paragraphs = content.split(/\n\n+/);
    const chunks: ChunkRecord[] = [];
    let accumulatedParagraphs: string[] = [];
    let accumulatedStartLine = startLine;
    let lineOffset = startLine;

    function flushAccumulated(): void {
        if (accumulatedParagraphs.length === 0) {
            return;
        }

        let chunkContent = accumulatedParagraphs.join("\n\n");

        if (chunkContent.trim().length === 0) {
            accumulatedParagraphs = [];
            return;
        }

        if (headingLine && chunks.length > 0) {
            chunkContent = `${headingLine}\n\n${chunkContent}`;
        }

        const chunkLines = chunkContent.split("\n");
        chunks.push({
            id: xxhash(chunkContent),
            filePath,
            startLine: accumulatedStartLine,
            endLine: accumulatedStartLine + chunkLines.length - 1,
            content: chunkContent,
            kind,
            name: chunks.length > 0 ? (name ? `${name} (part ${chunks.length + 1})` : undefined) : name,
            language,
        });

        accumulatedParagraphs = [];
    }

    for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
        const paragraph = paragraphs[pIdx];
        const paragraphLines = paragraph.split("\n").length;
        const separatorLines = pIdx > 0 ? 1 : 0;

        if (accumulatedParagraphs.length === 0) {
            accumulatedStartLine = lineOffset;
        }

        // Single paragraph exceeds maxTokens — fall back to line splitting for this paragraph
        const prefixForEstimate = headingLine && (chunks.length > 0 || accumulatedParagraphs.length > 0)
            ? `${headingLine}\n\n`
            : "";

        if (estimateTokens(prefixForEstimate + paragraph) > maxTokens) {
            flushAccumulated();

            const contentToSplit = headingLine && chunks.length > 0
                ? `${headingLine}\n\n${paragraph}`
                : paragraph;

            const subChunks = splitChunkByLines({
                content: contentToSplit,
                filePath,
                startLine: lineOffset,
                kind,
                name,
                language,
                maxTokens,
            });

            chunks.push(...subChunks);
            lineOffset += paragraphLines + separatorLines;
            continue;
        }

        const candidateContent = accumulatedParagraphs.length > 0
            ? `${accumulatedParagraphs.join("\n\n")}\n\n${paragraph}`
            : paragraph;

        const candidateWithHeading = headingLine && chunks.length > 0
            ? `${headingLine}\n\n${candidateContent}`
            : candidateContent;

        if (estimateTokens(candidateWithHeading) > maxTokens) {
            flushAccumulated();
            accumulatedStartLine = lineOffset;
        }

        accumulatedParagraphs.push(paragraph);
        lineOffset += paragraphLines + separatorLines;
    }

    flushAccumulated();

    return chunks;
}

// ─── Heading strategy (markdown) ────────────────────────────────
function chunkByHeading(opts: { filePath: string; content: string; maxTokens: number }): ChunkResult {
    const { filePath, content, maxTokens } = opts;
    const lines = content.split("\n");
    const chunks: ChunkRecord[] = [];
    let currentLines: string[] = [];
    let currentHeadingLine: string | undefined;
    let currentName: string | undefined;
    let currentStartLine = 0;
    let seenHeading = false;

    function flushSection(): void {
        if (currentLines.length === 0) {
            return;
        }

        const sectionContent = currentLines.join("\n");

        if (sectionContent.trim().length === 0) {
            return;
        }

        if (estimateTokens(sectionContent) <= maxTokens) {
            const sectionLines = sectionContent.split("\n");
            chunks.push({
                id: xxhash(sectionContent),
                filePath,
                startLine: currentStartLine,
                endLine: currentStartLine + sectionLines.length - 1,
                content: sectionContent,
                kind: "heading",
                name: currentName,
                language: "markdown",
            });
            return;
        }

        const subChunks = splitByParagraphs({
            content: sectionContent,
            filePath,
            startLine: currentStartLine,
            kind: "heading",
            name: currentName,
            language: "markdown",
            headingLine: currentHeadingLine,
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
            currentHeadingLine = line;
            currentName = headingMatch[2].trim();
            currentStartLine = i;
            seenHeading = true;
        } else {
            if (!seenHeading && currentLines.length === 0 && line.trim().length > 0 && currentName === undefined) {
                currentName = line.trim().slice(0, 50) || "(preamble)";
            }

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

    // Each source entry is already one message (MailSource produces 1 entry per email).
    // Don't split on "From:" or "Subject:" within a single message — those are headers.
    // Only split if the content has multiple email blocks separated by blank lines + headers.
    const hasMultipleMessages = /\n\n(?=From:|Subject:)/.test(content);

    if (!hasMultipleMessages) {
        // Single message — one chunk
        const subjectMatch = content.match(/Subject:\s*(.+)/);
        const name = subjectMatch ? subjectMatch[1].trim() : content.split("\n")[0];

        const subChunks = splitChunkByLines({
            content: content.trim(),
            filePath,
            startLine: 0,
            kind: "message",
            name,
            maxTokens,
        });

        return { chunks: subChunks, language: null, parser: "message" };
    }

    // Multiple messages in one content block (e.g., mbox format)
    const parts = content.split(/\n\n(?=From:|Subject:)/);
    const chunks: ChunkRecord[] = [];
    let lineOffset = 0;

    for (const part of parts) {
        const trimmed = part.trim();

        if (trimmed.length === 0) {
            lineOffset += part.split("\n").length;
            continue;
        }

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
        return chunkByLine({ filePath, content, maxTokens, overlap: 0 });
    }

    const chunks: ChunkRecord[] = [];

    if (Array.isArray(parsed)) {
        for (let i = 0; i < parsed.length; i++) {
            const elemContent = SafeJSON.stringify(parsed[i], null, 2);
            const subChunks = splitChunkByLines({
                content: elemContent,
                filePath,
                startLine: 0,
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
                startLine: 0,
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
            id: xxhash(stringified),
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

    if (EXT_TO_LANG[ext] || EXT_TO_DYNAMIC_LANG[ext]) {
        return "ast";
    }

    return "line";
}

// ─── Main entry point ───────────────────────────────────────────
export async function chunkFile(opts: {
    filePath: string;
    content: string;
    strategy: "ast" | "line" | "heading" | "message" | "json" | "character" | "auto";
    maxTokens?: number;
    indexType?: "code" | "files" | "mail" | "chat";
    overlap?: number;
}): Promise<ChunkResult> {
    const { filePath, content, strategy, indexType } = opts;
    const maxTokens = opts.maxTokens ?? 500;
    const overlap = opts.overlap ?? 0;

    const effectiveStrategy = strategy === "auto" ? selectAutoStrategy({ filePath, indexType }) : strategy;

    // Detect minified/bundled content — override strategy to character-based
    if (isMinified(content) && effectiveStrategy !== "message" && effectiveStrategy !== "json") {
        const charResult = chunkByCharacter({ filePath, content });
        return { ...charResult, chunks: applyCharCap(charResult.chunks) };
    }

    let result: ChunkResult;

    switch (effectiveStrategy) {
        case "ast": {
            const astResult = await chunkByAst({ filePath, content, maxTokens, overlap });

            if (astResult) {
                result = astResult;
            } else {
                // Fallback to line for unsupported languages
                result = chunkByLine({ filePath, content, maxTokens, overlap });
            }

            break;
        }

        case "heading":
            result = chunkByHeading({ filePath, content, maxTokens });
            break;

        case "message":
            result = chunkByMessage({ filePath, content, maxTokens });
            break;

        case "json":
            result = chunkByJson({ filePath, content, maxTokens });
            break;

        case "character":
            result = chunkByCharacter({ filePath, content });
            break;

        default:
            result = chunkByLine({ filePath, content, maxTokens, overlap });
            break;
    }

    return { ...result, chunks: applyCharCap(result.chunks) };
}
