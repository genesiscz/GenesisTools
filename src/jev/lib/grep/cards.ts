import { extname } from "node:path";
import type { Snapshot } from "./filesystem";
import type { Declaration, FilePreview } from "./requests";
import { inspect } from "./source";
import { jsonBytes } from "./types";

/** Opening bytes a card carries. The declaration index, not the opening, is what names the file's contents. */
export const CARD_TEXT_BYTES = 400;
/** Serialized declaration index a card may carry before it says `declarationIndexTruncated`. */
export const CARD_DECLARATION_BYTES = 900;

const SCRIPT_PATH = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const MARKDOWN_PATH = /\.(?:md|mdx|markdown)$/;
const MARKDOWN_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
/** One pattern for the declaration keywords most languages share; a card index, not a parser. */
const KEYWORD_DECLARATION =
    /^\s*(?:export\s+|pub(?:\([^)]*\))?\s+|public\s+|private\s+|internal\s+|static\s+|final\s+|abstract\s+|async\s+)*(?:def|class|func|fn|struct|enum|interface|trait|impl|protocol|extension|module|function|type)\s+([A-Za-z_][\w.:]*)/;

function openingText(source: string): string {
    const bytes = Buffer.from(source);
    if (bytes.length <= CARD_TEXT_BYTES) {
        return source;
    }

    let end = CARD_TEXT_BYTES;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
        end--;
    }

    const newline = bytes.subarray(0, end).lastIndexOf(10);
    return bytes.subarray(0, newline > 0 ? newline : end).toString("utf8");
}

function lineDeclarations(source: string, pattern: RegExp, name: (match: RegExpExecArray) => string): Declaration[] {
    const found: Declaration[] = [];
    for (const [index, line] of source.split("\n").entries()) {
        const match = pattern.exec(line);
        if (match) {
            found.push({ name: name(match), startLine: index + 1, endLine: index + 1 });
        }
    }

    return found;
}

function declarationsOf(snapshot: Snapshot): Declaration[] {
    if (Buffer.byteLength(snapshot.source) > 1_000_000) {
        return [];
    }

    if (SCRIPT_PATH.test(snapshot.path)) {
        const size = Buffer.byteLength(snapshot.source);
        return inspect(snapshot, { maxUnitBytes: Math.max(4, size) })
            .units.filter((unit) => !unit.partial && unit.name !== "source")
            .map((unit) => ({ name: unit.name, ...unit.range }));
    }

    if (MARKDOWN_PATH.test(snapshot.path)) {
        return lineDeclarations(snapshot.source, MARKDOWN_HEADING, (match) => `${match[1]} ${match[2]}`);
    }

    return lineDeclarations(snapshot.source, KEYWORD_DECLARATION, (match) => match[1]!);
}

/**
 * A file as budgeted discovery shows it to Jev: its opening lines and an index of what it declares
 * (TypeScript units, markdown headings, or keyword lines elsewhere). About a fifth of a 12 KB source
 * chunk, so one navigation call scores many files. A card is a shortlist signal only: a file is admitted
 * by upstream's full-source question, never by its card.
 */
export function fileCard(snapshot: Snapshot): FilePreview {
    const text = openingText(snapshot.source);
    const sizeBytes = Buffer.byteLength(snapshot.source);
    const declarations: Declaration[] = [];
    let declarationIndexTruncated = false;
    for (const declaration of declarationsOf(snapshot)) {
        if (jsonBytes([...declarations, declaration]) > CARD_DECLARATION_BYTES) {
            declarationIndexTruncated = true;
            break;
        }

        declarations.push(declaration);
    }

    return {
        sizeBytes,
        extension: extname(snapshot.path),
        text,
        previewBytes: Buffer.byteLength(text),
        truncated: Buffer.byteLength(text) < sizeBytes,
        range: "opening bytes",
        declarations,
        declarationIndexTruncated,
    };
}
