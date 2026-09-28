import ts from "typescript";
import type { Snapshot } from "./filesystem";
import type { Range } from "./types";

export interface SourceUnit {
    id: string;
    name: string;
    range: Range;
    /** Half-open UTF-8 byte span into the snapshot. */
    sourceByteStart: number;
    sourceByteEnd: number;
    partial?: boolean;
    ownerHeaders?: Range[];
}

/**
 * Upstream parses `.py` / `.pyi` with a bundled CPython. This port has no interpreter, so Python and
 * every other language take the text path. That is a coarser lead, not an issue kind: recording it
 * would mark every Python search incomplete.
 */
export interface Inspection {
    units: SourceUnit[];
    comments: Range[];
    mode: "typescript" | "text";
    fallback?: "unsupported" | "syntax" | "size";
}

interface SourceText {
    bytes: Buffer;
    offsets: number[];
    lineCount: number;
}

const TYPESCRIPT_PATH = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const PYTHON_PATH = /\.pyi?$/;

function sourceText(source: string): SourceText {
    const lines = source.split("\n");
    const offsets = [0];
    for (const line of lines) {
        offsets.push(offsets.at(-1)! + Buffer.byteLength(line) + 1);
    }

    return { bytes: Buffer.from(source), offsets, lineCount: lines.length };
}

function textUnits({
    text,
    range,
    name,
    maxBytes,
    partial,
}: {
    text: SourceText;
    range: Range;
    name: string;
    maxBytes: number;
    partial: boolean;
}): SourceUnit[] {
    const { bytes: raw, offsets, lineCount } = text;
    const units: SourceUnit[] = [];
    const first = Math.min(raw.length, offsets[range.startLine - 1] ?? raw.length);
    const end = Math.min(raw.length, offsets[range.endLine] ?? raw.length);
    let start = first;
    let line = range.startLine;
    while (start < end) {
        let finish = Math.min(end, start + maxBytes);
        if (finish < end) {
            // Never cut inside a UTF-8 sequence; prefer the last newline in the window.
            while (finish > start && (raw[finish]! & 0xc0) === 0x80) {
                finish--;
            }

            const newline = raw.subarray(start, finish).lastIndexOf(10);
            if (newline >= 0) {
                finish = start + newline + 1;
            }
        }

        const part = raw.subarray(start, finish).toString("utf8");
        const newlines = part.split("\n").length - 1;
        const endLine = line + newlines - (part.endsWith("\n") ? 1 : 0);
        units.push({
            id: `${name}:${start}:${finish}`,
            name,
            range: { startLine: line, endLine },
            sourceByteStart: start,
            sourceByteEnd: finish,
            ...(partial || first !== start || finish !== end ? { partial: true } : {}),
        });
        line += newlines;
        start = finish;
    }

    // The final empty line has no bytes but still belongs to the snapshot coordinates.
    if (raw.at(-1) === 10 && range.endLine === lineCount && units.length) {
        units.at(-1)!.range.endLine = lineCount;
    }

    return units;
}

function scriptKind(path: string): ts.ScriptKind {
    if (path.endsWith(".tsx")) {
        return ts.ScriptKind.TSX;
    }

    if (path.endsWith(".jsx")) {
        return ts.ScriptKind.JSX;
    }

    return /\.[cm]?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function parse(snapshot: Snapshot): ts.SourceFile {
    return ts.createSourceFile(snapshot.path, snapshot.source, ts.ScriptTarget.Latest, true, scriptKind(snapshot.path));
}

function hasParseErrors(file: ts.SourceFile): boolean {
    return Boolean((file as ts.SourceFile & { parseDiagnostics?: unknown[] }).parseDiagnostics?.length);
}

/** Declarations for TypeScript and JavaScript; bounded text chunks labeled `source` for everything else. */
export function inspect(
    snapshot: Snapshot,
    options: { maxUnitBytes?: number; maxParseBytes?: number } = {}
): Inspection {
    const maxUnitBytes = options.maxUnitBytes ?? 24_000;
    const maxParseBytes = options.maxParseBytes ?? 1_000_000;
    if (
        !Number.isSafeInteger(maxUnitBytes) ||
        maxUnitBytes < 4 ||
        !Number.isSafeInteger(maxParseBytes) ||
        maxParseBytes < 1
    ) {
        throw new Error("Source bounds must be integers; unit bytes at least 4 and parse bytes positive");
    }

    const { source, path } = snapshot;
    const text = sourceText(source);
    // Whole-line `#` comments, the same conservative rule upstream uses for its context windows.
    const pythonComments = PYTHON_PATH.test(path)
        ? source
              .split("\n")
              .flatMap((line, index) => (/^\s*#/.test(line) ? [{ startLine: index + 1, endLine: index + 1 }] : []))
        : [];
    const wholeText = (): SourceUnit[] =>
        source
            ? textUnits({
                  text,
                  range: { startLine: 1, endLine: text.lineCount },
                  name: "source",
                  maxBytes: maxUnitBytes,
                  partial: true,
              })
            : [];
    const fallback = (reason: Inspection["fallback"]): Inspection => ({
        mode: "text",
        fallback: reason,
        comments: pythonComments,
        units: wholeText(),
    });

    if (Buffer.byteLength(source) > maxParseBytes) {
        return fallback("size");
    }

    if (!TYPESCRIPT_PATH.test(path)) {
        return fallback("unsupported");
    }

    const file = parse(snapshot);
    const syntaxFallback = hasParseErrors(file);
    const line = (position: number) => file.getLineAndCharacterOfPosition(position).line + 1;
    const units: Array<{ name: string; range: Range; ownerHeaders?: Range[] }> = [];
    const add = (node: ts.Node, prefix = "", ownerHeaders: Range[] = []): void => {
        const named = node as ts.Node & { name?: ts.Node };
        const name =
            prefix +
            (named.name?.getText(file) ||
                (ts.isVariableStatement(node)
                    ? node.declarationList.declarations.map((declaration) => declaration.name.getText(file)).join(", ")
                    : "source"));
        if (ts.isClassDeclaration(node) && node.members.length) {
            const start = line(node.getStart(file));
            const first = line(node.members[0]!.getStart(file));
            const header = first > start ? { startLine: start, endLine: first - 1 } : undefined;
            const headers = header ? [...ownerHeaders, header] : ownerHeaders;
            if (header) {
                units.push({ name: `${name}.context`, range: header, ownerHeaders: headers });
            }

            for (const member of node.members) {
                add(member, `${name}.`, headers);
            }

            return;
        }

        units.push({
            name,
            ownerHeaders,
            range: { startLine: line(node.getStart(file)), endLine: line(Math.max(node.getStart(file), node.end - 1)) },
        });
    };

    if (!syntaxFallback) {
        for (const statement of file.statements) {
            add(statement);
        }
    }

    const comments: Range[] = [];
    const visit = (node: ts.Node): void => {
        for (const comment of [
            ...(ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []),
            ...(ts.getTrailingCommentRanges(source, node.end) ?? []),
        ]) {
            comments.push({ startLine: line(comment.pos), endLine: line(comment.end - 1) });
        }

        ts.forEachChild(node, visit);
    };
    visit(file);
    const sortedComments = [
        ...new Map(comments.map((range) => [`${range.startLine}:${range.endLine}`, range])).values(),
    ].sort((a, b) => a.startLine - b.startLine);

    // Invalid declarations fall back to text, but comments still own the context-window boundaries.
    if (syntaxFallback) {
        return { ...fallback("syntax"), comments: sortedComments };
    }

    if (!units.length && source) {
        return { units: wholeText(), comments: sortedComments, mode: "typescript" };
    }

    return {
        mode: "typescript",
        comments: sortedComments,
        units: units.flatMap((unit) => {
            const start = Math.min(text.bytes.length, text.offsets[unit.range.startLine - 1] ?? text.bytes.length);
            const end = Math.min(text.bytes.length, text.offsets[unit.range.endLine] ?? text.bytes.length);
            if (end - start <= maxUnitBytes) {
                return [
                    {
                        id: `${unit.name}:${start}:${end}`,
                        name: unit.name,
                        range: unit.range,
                        ownerHeaders: unit.ownerHeaders,
                        sourceByteStart: start,
                        sourceByteEnd: end,
                    },
                ];
            }

            return textUnits({ text, range: unit.range, name: unit.name, maxBytes: maxUnitBytes, partial: true }).map(
                (part) => ({ ...part, ownerHeaders: unit.ownerHeaders })
            );
        }),
    };
}

/** Byte spans include original line endings; a partial unit is never widened to whole lines. */
export function sourceForUnit(snapshot: Snapshot, unit: SourceUnit): string {
    return Buffer.from(snapshot.source).subarray(unit.sourceByteStart, unit.sourceByteEnd).toString("utf8");
}

/** Complete-file fragments keep admission independent of declaration-name sampling. */
export function splitSource(snapshot: Snapshot, maxBytes = 12_000): SourceUnit[] {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
        throw new Error("Invalid source byte allowance");
    }

    const text = sourceText(snapshot.source);
    return textUnits({
        text,
        range: { startLine: 1, endLine: text.lineCount },
        name: "source",
        maxBytes,
        partial: false,
    });
}
