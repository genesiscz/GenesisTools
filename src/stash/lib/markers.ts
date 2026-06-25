import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { CommentSyntax } from "./languages";

const { log } = logger.scoped("stash:markers");

export interface MarkerMeta {
    id?: string;
    v?: number;
    hunk?: number;
    src?: string;
    applied?: string;
}

export interface ParsedMarker {
    name: string;
    meta: MarkerMeta;
    startLine: number;
    endLine: number;
    contentStartLine: number;
    contentEndLine: number;
}

// Match `#region @stash:<name>` optionally followed by `{json}` metadata, tolerating trailing
// HTML/CSS close fragments. PR #222 t17: the CSS tail was `\/\*` (block-OPEN) but `emitOpenMarker`
// for CSS-family files emits a trailing `*/` (block-CLOSE) — so `.css/.scss/.less` markers never
// matched and were silently ignored. Now matches `*/` correctly.
const OPEN_RE = /#region\s+@stash:([\w.-]+)(?:\s+(\{.*?\}))?(?:\s*(?:-->|\*\/))?$/;
// Match `#endregion @stash:<name>` — name is kebab/dot/underscore.
const CLOSE_RE = /#endregion\s+@stash:([\w.-]+)/;

export function emitOpenMarker(args: { name: string; meta: MarkerMeta; syntax: CommentSyntax }): string {
    const json = SafeJSON.stringify(args.meta);
    if (args.syntax.line) {
        return `${args.syntax.line} #region @stash:${args.name} ${json}`;
    }
    // Invariant: commentSyntaxForFile always returns a SLASH fallback when no block syntax.
    const b = args.syntax.block!;
    return `${b.open} #region @stash:${args.name} ${json} ${b.close}`;
}

export function emitCloseMarker(args: { name: string; syntax: CommentSyntax }): string {
    if (args.syntax.line) {
        return `${args.syntax.line} #endregion @stash:${args.name}`;
    }
    // Invariant: commentSyntaxForFile always returns a SLASH fallback when no block syntax.
    const b = args.syntax.block!;
    return `${b.open} #endregion @stash:${args.name} ${b.close}`;
}

export function parseMarkers(source: string): ParsedMarker[] {
    const lines = source.split("\n");
    const opens: Array<{ name: string; meta: MarkerMeta; line: number }> = [];
    const closes: Array<{ name: string; line: number }> = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const closeMatch = CLOSE_RE.exec(line);
        if (closeMatch) {
            closes.push({ name: closeMatch[1] ?? "", line: i + 1 });
            continue;
        }
        const openMatch = OPEN_RE.exec(line);
        if (openMatch) {
            const name = openMatch[1] ?? "";
            const json = openMatch[2];
            let meta: MarkerMeta = {};
            if (json) {
                try {
                    meta = SafeJSON.parse(json) as MarkerMeta;
                } catch (err) {
                    // Don't swallow — surface in trace logs so corrupt markers are diagnosable
                    // without re-running. Default to {} so the marker is still recognized
                    // structurally even if the metadata is unreadable.
                    log.debug({ err, json, line: i + 1 }, "marker meta parse failed; defaulting to {}");
                    meta = {};
                }
            }
            opens.push({ name, meta, line: i + 1 });
        }
    }

    const out: ParsedMarker[] = [];
    for (const open of opens) {
        const close = closes.find((c) => c.name === open.name && c.line > open.line);
        if (!close) {
            continue;
        }
        out.push({
            name: open.name,
            meta: open.meta,
            startLine: open.line,
            endLine: close.line,
            contentStartLine: open.line + 1,
            contentEndLine: close.line - 1,
        });
    }
    return out;
}

export function stripMarkers(source: string): string {
    const lines = source.split("\n");
    const keep: string[] = [];
    for (const line of lines) {
        if (OPEN_RE.test(line) || CLOSE_RE.test(line)) {
            continue;
        }
        keep.push(line);
    }
    return keep.join("\n");
}
