import { existsSync } from "node:fs";
import { extname } from "node:path";
import { logger as rootLogger } from "@genesiscz/utils/logger";
import {
    defaultTransclusionRegistry,
    parseTranscludeText,
    type TokenSegment,
    TranscludeFailedError,
    type TransclusionRegistry,
    transclude,
} from "@genesiscz/utils/transclude";

/**
 * `{{kind …}}` tokens written INTO a markdown file, re-resolvable later.
 *
 * `tools question` resolves a token once and keeps only the result. A note needs the token back to
 * refresh the excerpt, so each resolved block is wrapped in two HTML comments that keep it:
 *
 *     <!-- md:include sig=1a2b3c4d5e6f {{lines path="/abs/a.ts" range="5-16"}} -->
 *     ```ts
 *     …the excerpt…
 *     ```
 *     _↳ captured 2026-10-01 18:20 UTC · a.ts · re-check: `{{lines …}}`_
 *     <!-- /md:include -->
 *
 * Obsidian and Genesis hide HTML comments; the dev-dashboard share page drops them. `sig` is the
 * excerpt's content hash: a refresh that finds the same content leaves the block byte for byte as it
 * was, so re-running never rewrites a file only for a new capture time.
 */

export const INCLUDE_CLOSE = "<!-- /md:include -->";
const BLOCK_RE =
    /<!-- md:include(?: sig=([0-9a-f]+))?( inline)? (\{\{[\s\S]*?\}\}) -->([\s\S]*?)<!-- \/md:include -->/g;
/** A block placed inside a sentence brought its own blank lines; collapsing takes them back out. */
const COLLAPSE_RE =
    /(\n\n)?<!-- md:include(?: sig=[0-9a-f]+)?( inline)? (\{\{[\s\S]*?\}\}) -->[\s\S]*?<!-- \/md:include -->(\n\n)?/g;
const SIG_CHARS = 12;

/** Kinds a note cannot carry: `image` copies the picture into the decision log's own store. */
export const UNSUPPORTED_IN_NOTES: Record<string, string> = {
    image: "copies the picture into the decision log's store; in a note, link the image with ![](path) instead",
};

export type IncludeAction = "added" | "refreshed" | "unchanged" | "kept" | "failed" | "skipped";

export interface IncludeOutcome {
    raw: string;
    kind: string;
    /** 1-based line of the token or block in the input. */
    line: number;
    action: IncludeAction;
    error?: string;
}

export interface ResolveIncludesOptions {
    /** Relative token paths resolve from here (a note's own folder). */
    cwd: string;
    /** Resolve the token of every existing block again (default). False: only bare tokens. */
    refresh?: boolean;
    registry?: TransclusionRegistry;
    now?: () => Date;
}

export interface ResolveIncludesResult {
    text: string;
    changed: boolean;
    outcomes: IncludeOutcome[];
}

export function includeOpen(raw: string, signature: string, inline = false): string {
    return `<!-- md:include sig=${signature.slice(0, SIG_CHARS)}${inline ? " inline" : ""} ${raw} -->`;
}

/**
 * Every include block back to the bare token it came from. `collapseIncludes(after)` equals the text the
 * run started from: the check `tools markdown resolve` makes before it writes a file.
 */
export function collapseIncludes(text: string): string {
    return text.replace(
        COLLAPSE_RE,
        (_whole, before: string | undefined, inline: string | undefined, raw: string, after: string | undefined) => {
            if (inline) {
                return raw;
            }

            return `${before ?? ""}${raw}${after ?? ""}`;
        }
    );
}

function lineAt(text: string, offset: number): number {
    let line = 1;

    for (let i = 0; i < offset && i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
            line++;
        }
    }

    return line;
}

interface Resolved {
    ok: true;
    body: string;
    signature: string;
}

interface Failed {
    ok: false;
    error: string;
}

/** One token through the shared engine, failing closed: a note never gets a failure marker written into it. */
async function resolveToken(
    raw: string,
    options: ResolveIncludesOptions,
    registry: TransclusionRegistry
): Promise<Resolved | Failed> {
    try {
        const result = await transclude(raw, {
            registry,
            cwd: options.cwd,
            onFailure: "throw",
            callerReports: true,
            label: "markdown include",
            ...(options.now ? { now: options.now } : {}),
        });
        const token = result.tokens[0];

        if (!token?.ok || !token.signature) {
            return { ok: false, error: token?.error ?? "the token did not resolve" };
        }

        return { ok: true, body: result.text.trim(), signature: token.signature };
    } catch (error) {
        if (error instanceof TranscludeFailedError) {
            return { ok: false, error: error.failed.map((failed) => failed.error ?? "failed").join("; ") };
        }

        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

function wrap(raw: string, resolved: Resolved, inline = false): string {
    return `${includeOpen(raw, resolved.signature, inline)}\n${resolved.body}\n${INCLUDE_CLOSE}`;
}

/** A block result on a line of its own replaces the token there; inside a sentence it gets its own paragraph. */
function placeNew(raw: string, resolved: Resolved, segment: TokenSegment): string {
    const block = resolved.body.includes("\n");

    if (!block) {
        return `${includeOpen(raw, resolved.signature)}${resolved.body}${INCLUDE_CLOSE}`;
    }

    return segment.standalone ? wrap(raw, resolved) : `\n\n${wrap(raw, resolved, true)}\n\n`;
}

async function resolveText(
    part: string,
    offset: number,
    whole: string,
    options: ResolveIncludesOptions,
    registry: TransclusionRegistry,
    outcomes: IncludeOutcome[]
): Promise<string> {
    let out = "";
    let cursor = 0;

    for (const segment of parseTranscludeText(part)) {
        // The parser unescapes `\{{` in its text; a note keeps its own bytes, so text is copied by offset.
        if (segment.type === "text") {
            continue;
        }

        out += part.slice(cursor, segment.start);
        cursor = segment.end;
        const line = lineAt(whole, offset + segment.start);
        const unsupported = UNSUPPORTED_IN_NOTES[segment.kind];

        if (unsupported || segment.error) {
            outcomes.push({
                raw: segment.raw,
                kind: segment.kind,
                line,
                action: "skipped",
                error: unsupported ?? segment.error,
            });
            out += segment.raw;
            continue;
        }

        const resolved = await resolveToken(segment.raw, options, registry);

        if (!resolved.ok) {
            outcomes.push({ raw: segment.raw, kind: segment.kind, line, action: "failed", error: resolved.error });
            out += segment.raw;
            continue;
        }

        outcomes.push({ raw: segment.raw, kind: segment.kind, line, action: "added" });
        out += placeNew(segment.raw, resolved, segment);
    }

    return out + part.slice(cursor);
}

function kindOf(raw: string): string {
    return /^\{\{#?\s*([\w-]+)/.exec(raw)?.[1] ?? "?";
}

/**
 * Resolves the bare tokens of a markdown text into include blocks, and (unless `refresh: false`)
 * every existing block again from its kept token. A token that fails stays as it was written, and a
 * block whose token fails keeps its old content: a run never loses text it could not replace.
 */
export async function resolveIncludes(text: string, options: ResolveIncludesOptions): Promise<ResolveIncludesResult> {
    const registry = options.registry ?? defaultTransclusionRegistry();
    const refresh = options.refresh ?? true;
    const outcomes: IncludeOutcome[] = [];
    let out = "";
    let cursor = 0;
    // A block written inside a fenced example is text: it is not refreshed, and the fence is not split.
    const fences = fencedRanges(text);

    for (const match of text.matchAll(BLOCK_RE)) {
        const start = match.index ?? 0;

        if (fences.some(([from, to]) => start >= from && start < to) || inInlineCode(text, start)) {
            continue;
        }

        out += await resolveText(text.slice(cursor, start), cursor, text, options, registry, outcomes);
        cursor = start + match[0].length;

        const inline = match[2] !== undefined;
        const raw = match[3] ?? "";
        const kind = kindOf(raw);
        const line = lineAt(text, start);

        if (!refresh) {
            outcomes.push({ raw, kind, line, action: "kept" });
            out += match[0];
            continue;
        }

        const resolved = await resolveToken(raw, options, registry);

        if (!resolved.ok) {
            outcomes.push({
                raw,
                kind,
                line,
                action: "failed",
                error: `${resolved.error} (the block keeps its old content)`,
            });
            out += match[0];
            continue;
        }

        if (match[1] && resolved.signature.startsWith(match[1])) {
            outcomes.push({ raw, kind, line, action: "unchanged" });
            out += match[0];
            continue;
        }

        outcomes.push({ raw, kind, line, action: "refreshed" });
        out += wrap(raw, resolved, inline);
    }

    out += await resolveText(text.slice(cursor), cursor, text, options, registry, outcomes);
    const changed = out !== text;
    rootLogger.debug(
        {
            tokens: outcomes.length,
            added: outcomes.filter((o) => o.action === "added").length,
            refreshed: outcomes.filter((o) => o.action === "refreshed").length,
            failed: outcomes.filter((o) => o.action === "failed").length,
            changed,
        },
        "markdown includes resolved"
    );
    return { text: out, changed, outcomes };
}

// MARK: - Code links to tokens

/** Source files a `/abs/a.ts#L5` link may point at; the token's code fence takes its language from the extension. */
export const CODE_EXTENSIONS = new Set([
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
    ".sh",
    ".bash",
    ".zsh",
    ".swift",
    ".go",
    ".rs",
    ".rb",
    ".java",
    ".kt",
    ".php",
    ".c",
    ".h",
    ".cpp",
    ".hpp",
    ".m",
    ".css",
    ".scss",
    ".html",
    ".xml",
    ".yaml",
    ".yml",
    ".toml",
    ".sql",
    ".vue",
    ".svelte",
]);

export interface CodeLinkInsert {
    /** 1-based line of the link in the input. */
    line: number;
    label: string;
    path: string;
    range: string;
    token: string;
}

export interface CodeLinksResult {
    text: string;
    inserted: CodeLinkInsert[];
    skipped: { line: number; label: string; reason: string }[];
}

const LINK_RE = /\[([^\]\n]*)\]\(<?((?:file:\/\/)?\/[^)\s>]+)>?\)/g;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** True when `offset` sits inside a backtick code span on its own line. */
function inInlineCode(text: string, offset: number): boolean {
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const lineEnd = text.indexOf("\n", offset);
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    const column = offset - lineStart;

    return [...line.matchAll(INLINE_CODE_RE)].some(
        (span) => column > (span.index ?? 0) && column < (span.index ?? 0) + span[0].length
    );
}

/** CommonMark: a fence closes on its own marker character, at least as long, with nothing after it. */
function closesFence(lineText: string, match: RegExpExecArray, fence: string): boolean {
    const marker = match[1] ?? "";
    return (
        marker.startsWith(fence[0] ?? "`") &&
        marker.length >= fence.length &&
        lineText.slice(match[0].length).trim() === ""
    );
}
const INLINE_CODE_RE = /(`+)[^`].*?\1/g;

/** Offsets `[start, end)` of every fenced code block, fences included; an unclosed fence runs to the end. */
function fencedRanges(text: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    let fence: string | null = null;
    let openedAt = 0;
    let offset = 0;

    for (const lineText of text.split("\n")) {
        const match = FENCE_RE.exec(lineText);
        const marker = match?.[1];

        if (marker && fence === null) {
            fence = marker;
            openedAt = offset;
        } else if (match && fence !== null && closesFence(lineText, match, fence)) {
            ranges.push([openedAt, offset + lineText.length]);
            fence = null;
        }

        offset += lineText.length + 1;
    }

    if (fence !== null) {
        ranges.push([openedAt, text.length]);
    }

    return ranges;
}

function decodedPath(target: string): { path: string; start: number | null; end: number | null } | null {
    const [location, fragment = ""] = target.split("#", 2);

    if (!location) {
        return null;
    }

    let path: string;

    try {
        path = decodeURIComponent(location.replace(/^file:\/\//, ""));
    } catch {
        return null;
    }

    const range = /^L(\d{1,7})(?:-L?(\d{1,7}))?$/.exec(fragment);
    return { path, start: range ? Number(range[1]) : null, end: range?.[2] ? Number(range[2]) : null };
}

/** A token string the way `parseTranscludeText` reads it back. */
export function linesToken(path: string, range: string): string {
    return `{{lines path="${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" range="${range}"}}`;
}

/**
 * Adds a `{{lines}}` token after the paragraph of every link to a line of a source file
 * (`[a.ts:5](/abs/a.ts#L5)`, with or without `file://`), so the next resolve puts the excerpt under the text that cites it.
 * The link itself stays: it still opens the file in Obsidian and Genesis. Links in code, links to a whole
 * file, to a missing file or to a non-source file, links whose paragraph a code block already follows,
 * and links whose token the text already holds are skipped.
 * A single line gets `context` lines from it on.
 */
export function codeLinksToTokens(text: string, { context = 12 }: { context?: number } = {}): CodeLinksResult {
    const lines = text.split("\n");
    const inserted: CodeLinkInsert[] = [];
    const skipped: CodeLinksResult["skipped"] = [];
    const pending = new Map<number, string[]>();
    const seen = new Set<string>();
    let fence: string | null = null;

    for (let index = 0; index < lines.length; index++) {
        const lineText = lines[index] ?? "";
        const fenceMatch = FENCE_RE.exec(lineText);

        if (fenceMatch) {
            const marker = fenceMatch[1] ?? "";

            if (fence === null) {
                fence = marker;
            } else if (closesFence(lineText, fenceMatch, fence)) {
                fence = null;
            }

            continue;
        }

        if (fence !== null || lineText.includes("md:include")) {
            continue;
        }

        // A link written inside `inline code` is an example of the syntax, not a link.
        const prose = lineText.replace(INLINE_CODE_RE, (span) => " ".repeat(span.length));

        for (const match of prose.matchAll(LINK_RE)) {
            const label = match[1] ?? "";
            const parsed = decodedPath(match[2] ?? "");
            const line = index + 1;

            if (!parsed || !CODE_EXTENSIONS.has(extname(parsed.path).toLowerCase())) {
                continue;
            }

            if (parsed.start === null) {
                skipped.push({ line, label, reason: "links to the whole file, not to lines" });
                continue;
            }

            if (!existsSync(parsed.path)) {
                skipped.push({ line, label, reason: "the file is not on this Mac" });
                continue;
            }

            const end = parsed.end ?? parsed.start + context - 1;
            const range = `${parsed.start}-${Math.max(parsed.start, end)}`;
            const token = linesToken(parsed.path, range);

            if (seen.has(token) || text.includes(token)) {
                skipped.push({ line, label, reason: "the note already holds this excerpt" });
                continue;
            }

            seen.add(token);
            // After the paragraph (or list, or table) the link sits in: the next blank line, a fence, or the end.
            let after = index;

            while (
                after + 1 < lines.length &&
                (lines[after + 1] ?? "").trim() !== "" &&
                !FENCE_RE.test(lines[after + 1] ?? "")
            ) {
                after++;
            }

            // A code block right under the paragraph is an excerpt someone already pasted there.
            let next = after + 1;

            while (next < lines.length && (lines[next] ?? "").trim() === "") {
                next++;
            }

            if (FENCE_RE.test(lines[next] ?? "")) {
                skipped.push({ line, label, reason: "a code block already follows the paragraph" });
                continue;
            }

            pending.set(after, [...(pending.get(after) ?? []), token]);
            inserted.push({ line, label, path: parsed.path, range, token });
        }
    }

    if (inserted.length === 0) {
        return { text, inserted, skipped };
    }

    const out: string[] = [];

    for (let index = 0; index < lines.length; index++) {
        out.push(lines[index] ?? "");
        const tokens = pending.get(index);

        if (tokens) {
            out.push("", ...tokens.flatMap((token, i) => (i === 0 ? [token] : ["", token])));

            // A fence right under the paragraph would otherwise follow the token line directly.
            if (index + 1 < lines.length && (lines[index + 1] ?? "").trim() !== "") {
                out.push("");
            }
        }
    }

    return { text: out.join("\n"), inserted, skipped };
}
