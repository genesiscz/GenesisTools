import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { sourceMappingUrlOf } from "../deployed.ts";
import { type OriginalPosition, SourceMapIndex } from "../source-map.ts";
import type { GeneratedPosition, ResolverAttempt } from "./types.ts";

const maps = new Map<string, Promise<SourceMapIndex>>();

/**
 * The map file of a local JS file: its own `sourceMappingURL` (relative to the file) when that names a
 * file, else `<file>.map`. Null when neither exists (some chunks are emitted without a map).
 */
export async function localMapPath(dir: string, jsPath: string, code: string): Promise<string | null> {
    const reference = sourceMappingUrlOf(code);
    const candidates = [
        ...(reference && !reference.startsWith("data:") ? [join(dirname(join(dir, jsPath)), reference)] : []),
        join(dir, `${jsPath}.map`),
    ];
    for (const candidate of candidates) {
        if (await Bun.file(candidate).exists()) {
            return candidate;
        }
    }

    return null;
}

/** Parses a map file once per process. */
export function loadMap(path: string): Promise<SourceMapIndex> {
    let loaded = maps.get(path);
    if (!loaded) {
        loaded = readFile(path, "utf8").then((text) => SourceMapIndex.parse(SafeJSON.parse(text, { strict: true })));
        maps.set(path, loaded);
    }

    return loaded;
}

/**
 * The character offset of a position in `code`, or -1 when the position is not inside the file: an offset past
 * the end, a line that does not exist, a column past the end of its line (it must not spill into the next line),
 * or a value that is not a whole non-negative number.
 */
export function offsetOf(code: string, position: GeneratedPosition): number {
    if ("offset" in position) {
        const { offset } = position;
        return Number.isInteger(offset) && offset >= 0 && offset < code.length ? offset : -1;
    }

    if (!Number.isInteger(position.line) || position.line < 1) {
        return -1;
    }

    if (!Number.isInteger(position.column) || position.column < 0) {
        return -1;
    }

    let lineStart = 0;
    for (let line = 1; line < position.line; line++) {
        const next = code.indexOf("\n", lineStart);
        if (next === -1) {
            return -1;
        }

        lineStart = next + 1;
    }

    const lineEnd = code.indexOf("\n", lineStart);
    const lineLength = (lineEnd === -1 ? code.length : lineEnd) - lineStart;
    const offset = lineStart + position.column;
    return position.column <= lineLength && offset < code.length ? offset : -1;
}

/** The unresolved answer for a position `offsetOf` refused. */
export function outsideFile(resolver: string, path: string, code: string): ResolverAttempt {
    return { resolver, result: null, reason: `the position is outside ${path} (${code.length} characters)` };
}

/** Up to `radius` source lines on each side of the original position, numbered, the hit line marked with `>`. */
export function excerptOf(map: SourceMapIndex, position: OriginalPosition, radius = 3): string[] | undefined {
    const content =
        map.sourceContent(position.source) ?? map.sourceContent(position.source.replace(/^.*?(?=webpack:)/, ""));
    if (!content) {
        return undefined;
    }

    const lines = content.split("\n");
    const from = Math.max(1, position.line - radius);
    const to = Math.min(lines.length, position.line + radius);
    const out: string[] = [];
    for (let line = from; line <= to; line++) {
        out.push(`${line === position.line ? ">" : " "} ${String(line).padStart(5)} | ${lines[line - 1]}`);
    }

    return out;
}

/**
 * The literal token at an offset of minified code, the kind that survives minification unchanged: a string
 * literal's text, or a property name after `.`. Null for anything else (mangled names say nothing).
 */
export function literalTokenAt(code: string, offset: number): string | null {
    const quote = code[offset];
    if (quote === '"' || quote === "'" || quote === "`") {
        let end = offset + 1;
        while (end < code.length && end - offset < 160 && code[end] !== quote) {
            end += code[end] === "\\" ? 2 : 1;
        }

        const text = code.slice(offset + 1, end);
        return text.length >= 4 && !text.includes("\\") ? text : null;
    }

    if (code[offset - 1] === "." && /[A-Za-z_$]/.test(quote ?? "")) {
        const match = /^[A-Za-z_$][\w$]*/.exec(code.slice(offset, offset + 80));
        return match && match[0].length >= 4 ? match[0] : null;
    }

    return null;
}

/**
 * Coarse map segments put a whole construct on its first line (a TypeScript enum, an object literal).
 * When the deployed position holds a literal token, move to the first line at or after the mapped one, within
 * `window` lines, whose source contains it. Null when the token is not there (the position stays as mapped).
 */
export function snapToToken(options: {
    map: SourceMapIndex;
    position: OriginalPosition;
    token: string;
    window?: number;
}): OriginalPosition | null {
    const content = options.map.sourceContent(options.position.source);
    if (!content) {
        return null;
    }

    const lines = content.split("\n");
    const last = Math.min(lines.length, options.position.line + (options.window ?? 120));
    for (let line = options.position.line; line <= last; line++) {
        const column = lines[line - 1]?.indexOf(options.token) ?? -1;
        if (column >= 0) {
            return line === options.position.line ? null : { ...options.position, line, column };
        }
    }

    return null;
}

/** Collapses `webpack:///../src/x.ts` style prefixes to a repo-relative looking path. */
export function displaySource(source: string): string {
    return source.replace(/^webpack:\/\/\/?(?:\.\.?\/)*/, "").replace(/^[a-z]+:\/\/\/?/, "");
}
