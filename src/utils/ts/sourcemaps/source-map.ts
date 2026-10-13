const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGIT = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) {
    DIGIT[BASE64.charCodeAt(i)] = i;
}

/** Fields per decoded segment: generated column, source index, original line, original column, name index (-1 = none). */
const STRIDE = 5;

export interface RawSourceMap {
    version: number;
    file?: string;
    sourceRoot?: string;
    sources: string[];
    sourcesContent?: Array<string | null>;
    names?: string[];
    mappings: string;
}

export interface OriginalPosition {
    source: string;
    /** 1-based. */
    line: number;
    /** 0-based. */
    column: number;
    name: string | null;
}

export class SourceMapError extends Error {}

function isRawSourceMap(value: unknown): value is RawSourceMap {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const map = value as Record<string, unknown>;
    return map.version === 3 && Array.isArray(map.sources) && typeof map.mappings === "string";
}

/**
 * Decodes the `mappings` string of a v3 source map into one flat Int32Array per generated line,
 * STRIDE fields per segment, columns absolute. Throws on a malformed VLQ.
 */
export function decodeMappings(mappings: string): Int32Array[] {
    const lines: Int32Array[] = [];
    let line: number[] = [];
    let source = 0;
    let originalLine = 0;
    let originalColumn = 0;
    let name = 0;
    let generatedColumn = 0;
    const fields: number[] = [];
    let value = 0;
    let shift = 0;

    const flushSegment = (): void => {
        if (fields.length === 0) {
            return;
        }

        if (fields.length !== 1 && fields.length !== 4 && fields.length !== 5) {
            throw new SourceMapError(`segment with ${fields.length} fields on generated line ${lines.length + 1}`);
        }

        generatedColumn += fields[0];
        if (fields.length === 1) {
            line.push(generatedColumn, -1, -1, -1, -1);
        } else {
            source += fields[1];
            originalLine += fields[2];
            originalColumn += fields[3];
            if (fields.length === 5) {
                name += fields[4];
            }

            line.push(generatedColumn, source, originalLine, originalColumn, fields.length === 5 ? name : -1);
        }

        fields.length = 0;
    };

    for (let i = 0; i <= mappings.length; i++) {
        const code = i < mappings.length ? mappings.charCodeAt(i) : 59;
        if (code === 44 || code === 59) {
            if (shift !== 0) {
                throw new SourceMapError(`truncated VLQ at mappings offset ${i}`);
            }

            flushSegment();
            if (code === 59) {
                lines.push(Int32Array.from(line));
                line = [];
                generatedColumn = 0;
            }

            continue;
        }

        const digit = code < 128 ? DIGIT[code] : -1;
        if (digit < 0) {
            throw new SourceMapError(`invalid base64 character at mappings offset ${i}`);
        }

        value += (digit & 31) * 2 ** shift;
        if (digit & 32) {
            shift += 5;
            continue;
        }

        fields.push(value % 2 === 1 ? -Math.floor(value / 2) : Math.floor(value / 2));
        value = 0;
        shift = 0;
    }

    if (mappings.length === 0) {
        return [];
    }

    return lines;
}

/** A parsed v3 source map (not an index map) with a generated-to-original lookup. */
export class SourceMapIndex {
    private readonly lines: Int32Array[];

    private constructor(readonly raw: RawSourceMap) {
        this.lines = decodeMappings(raw.mappings);
    }

    static parse(json: unknown): SourceMapIndex {
        if (typeof json === "object" && json !== null && "sections" in json) {
            throw new SourceMapError("index source maps (sections) are not supported");
        }

        if (!isRawSourceMap(json)) {
            throw new SourceMapError("not a v3 source map (need version 3, sources[] and mappings)");
        }

        return new SourceMapIndex(json);
    }

    get sources(): string[] {
        return this.raw.sources;
    }

    /** `sourceRoot` as the prefix `originalPositionFor` puts in front of every source, or "". */
    private get rootPrefix(): string {
        return this.raw.sourceRoot ? this.raw.sourceRoot.replace(/\/?$/, "/") : "";
    }

    /**
     * The original source text embedded in the map, or null when the map has no sourcesContent for it. Takes a
     * source as `originalPositionFor` names it (with the `sourceRoot` prefix) or as `sources` lists it.
     */
    sourceContent(source: string): string | null {
        let index = this.raw.sources.indexOf(source);
        const root = this.rootPrefix;
        if (index < 0 && root && source.startsWith(root)) {
            index = this.raw.sources.indexOf(source.slice(root.length));
        }

        return index < 0 ? null : (this.raw.sourcesContent?.[index] ?? null);
    }

    /**
     * Maps a generated position (1-based line, 0-based column) to the original position of the
     * closest segment at or before it on that line. Null when the line has no mapped segment there.
     */
    originalPositionFor(position: { line: number; column: number }): OriginalPosition | null {
        const segments = this.lines[position.line - 1];
        if (!segments || segments.length === 0) {
            return null;
        }

        let low = 0;
        let high = segments.length / STRIDE - 1;
        let found = -1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (segments[mid * STRIDE] <= position.column) {
                found = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        // A one-field segment starts an unmapped region: the position has no original, so never
        // fall back to an earlier mapped segment.
        if (found < 0 || segments[found * STRIDE + 1] < 0) {
            return null;
        }

        const at = found * STRIDE;
        const nameIndex = segments[at + 4];
        return {
            source: this.rootPrefix + this.raw.sources[segments[at + 1]],
            line: segments[at + 2] + 1,
            column: segments[at + 3],
            name: nameIndex >= 0 ? (this.raw.names?.[nameIndex] ?? null) : null,
        };
    }
}

/** 1-based line and 0-based column of a character offset. */
export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
    let line = 1;
    let lineStart = 0;
    let next = text.indexOf("\n");
    while (next !== -1 && next < offset) {
        line++;
        lineStart = next + 1;
        next = text.indexOf("\n", lineStart);
    }

    return { line, column: offset - lineStart };
}

/** Character offset of a 1-based line and 0-based column, or -1 when the line does not exist. */
export function offsetAt(text: string, position: { line: number; column: number }): number {
    let lineStart = 0;
    for (let line = 1; line < position.line; line++) {
        const next = text.indexOf("\n", lineStart);
        if (next === -1) {
            return -1;
        }

        lineStart = next + 1;
    }

    return lineStart + position.column;
}
