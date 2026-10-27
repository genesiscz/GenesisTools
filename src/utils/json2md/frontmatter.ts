/**
 * Front matter in YAML, JSON or TOML.
 *
 * The YAML emitter is written by hand on purpose. `yaml` and `js-yaml` are present in this
 * repo only as transitive packages, and adding either as a direct dependency would also add
 * it to the downstream vendor set. Emitting the small subset front matter actually uses is
 * about sixty lines, and `frontmatter.test.ts` pins the quoting rules.
 */

import { SafeJSON } from "@genesiscz/utils/json";
import TOML from "@iarna/toml";

export type FrontmatterFormat = "yaml" | "json" | "toml";

/** Scalars that YAML would otherwise read as a boolean, a null or a number. */
const AMBIGUOUS_SCALAR = /^(?:true|false|yes|no|on|off|null|~|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/i;

/** Leading characters that start a YAML structure rather than a plain scalar. */
const RESERVED_START = /^[-?:,[\]{}#&*!|>'"%@`]/;

function needsQuotes(value: string): boolean {
    if (value === "") {
        return true;
    }

    if (value !== value.trim()) {
        return true;
    }

    if (RESERVED_START.test(value)) {
        return true;
    }

    if (AMBIGUOUS_SCALAR.test(value)) {
        return true;
    }

    return /:\s|\s#|[\n\r\t]/.test(value);
}

/**
 * A double-quoted scalar. Line breaks and tabs are escaped rather than refused: an array item
 * reaches this directly (only a map value gets the `|` block form), and returning `""` for a
 * multi-line item emitted `- ` and lost the value.
 */
function quoteYaml(value: string): string {
    return `"${value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t")}"`;
}

function yamlScalar(value: unknown): string {
    if (value === null || value === undefined) {
        return "null";
    }

    if (typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") {
        return String(value);
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    const text = String(value);

    if (!needsQuotes(text)) {
        return text;
    }

    return quoteYaml(text);
}

function yamlValue(value: unknown, indent: number): string {
    const pad = " ".repeat(indent);

    if (typeof value === "string" && value.includes("\n")) {
        // A literal block scalar is the only shape that keeps line breaks readable.
        // `|` clips to exactly one trailing newline on read, so a value without one came back
        // with one added. `|-` strips it, so the value round-trips byte for byte.
        const indicator = value.endsWith("\n") ? "|" : "|-";
        const body = value
            .replace(/\n$/, "")
            .split("\n")
            .map((line) => `${pad}  ${line}`)
            .join("\n");

        return `${indicator}\n${body}`;
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return "[]";
        }

        return `\n${value
            .map((item) => {
                if (item !== null && typeof item === "object" && !(item instanceof Date)) {
                    return `${pad}  - ${yamlObject(item as Record<string, unknown>, indent + 4).trimStart()}`;
                }

                return `${pad}  - ${yamlScalar(item)}`;
            })
            .join("\n")}`;
    }

    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
        const entries = Object.entries(value as Record<string, unknown>);

        if (entries.length === 0) {
            return "{}";
        }

        return `\n${yamlObject(value as Record<string, unknown>, indent + 2)}`;
    }

    return yamlScalar(value);
}

function yamlObject(data: Record<string, unknown>, indent: number): string {
    const pad = " ".repeat(indent);

    return Object.entries(data)
        .map(([key, value]) => `${pad}${key}: ${yamlValue(value, indent)}`.replace(/: \n/, ":\n").replace(/: $/, ":"))
        .join("\n");
}

/** Emits YAML for the subset of shapes front matter uses: scalars, lists and nested maps. */
export function toYaml(data: Record<string, unknown>): string {
    return yamlObject(data, 0);
}

/**
 * Wraps metadata in a front-matter block.
 *
 * TOML front matter is delimited by `+++`, which is the Hugo convention. YAML and JSON both
 * use `---`, which is what every other static-site generator expects.
 */
export function renderFrontmatter(data: Record<string, unknown>, format: FrontmatterFormat = "yaml"): string {
    if (Object.keys(data).length === 0) {
        return "";
    }

    if (format === "json") {
        return `---\n${SafeJSON.stringify(data, null, 2)}\n---`;
    }

    if (format === "toml") {
        return `+++\n${TOML.stringify(data as TOML.JsonMap).trimEnd()}\n+++`;
    }

    return `---\n${toYaml(data)}\n---`;
}

const FRONTMATTER_RE = /^(---|\+\+\+)\r?\n([\s\S]*?)\r?\n\1\s*(?:\r?\n|$)/;

/** Splits a document into its front-matter text and its body. Does not parse the metadata. */
export function splitFrontmatter(source: string): {
    raw: string | null;
    format: FrontmatterFormat | null;
    body: string;
} {
    const match = source.match(FRONTMATTER_RE);

    if (!match) {
        return { raw: null, format: null, body: source };
    }

    const delimiter = match[1]!;
    const body = source.slice(match[0].length);

    if (delimiter === "+++") {
        return { raw: match[2]!, format: "toml", body };
    }

    const text = match[2]!.trimStart();

    return { raw: match[2]!, format: text.startsWith("{") ? "json" : "yaml", body };
}

/** One top-level entry of a YAML front matter block: its key, and its lines (the key line and its block). */
interface YamlEntry {
    /** Null for comments or blank lines before the first key. */
    key: string | null;
    lines: string[];
}

/** A top-level YAML key at column 0: plain, double-quoted or single-quoted, then a colon. */
const TOP_LEVEL_KEY = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#'"\-?:,[\]{}&*!|>%@`][^:#]*?))[ \t]*:(?:[ \t]|$)/;

const YAML_ESCAPES: Record<string, string> = {
    "0": "\0",
    a: "\x07",
    b: "\b",
    t: "\t",
    "\t": "\t",
    n: "\n",
    v: "\v",
    f: "\f",
    r: "\r",
    e: "\x1b",
    " ": " ",
    '"': '"',
    "/": "/",
    "\\": "\\",
    N: "\u0085",
    _: " ",
    L: " ",
    P: " ",
};

/** Decode key identity without changing the original lines that carry it. */
function yamlDoubleQuotedKey(key: string): string {
    return key.replace(/\\(?:[0abtnvfre "/\\N_LP\t]|x[\da-fA-F]{2}|u[\da-fA-F]{4}|U[\da-fA-F]{8})/g, (escaped) => {
        const kind = escaped[1]!;

        if (kind === "x" || kind === "u" || kind === "U") {
            const value = Number.parseInt(escaped.slice(2), 16);
            return value <= 0x10ffff ? String.fromCodePoint(value) : escaped;
        }

        return YAML_ESCAPES[kind] ?? escaped;
    });
}

/**
 * The top-level entries of YAML front matter text, read by lines rather than parsed: a key starts at column 0,
 * and every line that does not start a key (an indented block, a `- ` item, a comment, a blank line) belongs to
 * the entry above it. That is all carrying an entry needs, and it keeps each entry's text byte for byte.
 */
function yamlEntries(raw: string): YamlEntry[] {
    const entries: YamlEntry[] = [];

    for (const line of raw.split("\n")) {
        const match = line.match(TOP_LEVEL_KEY);

        if (match) {
            const key =
                match[1] !== undefined
                    ? yamlDoubleQuotedKey(match[1])
                    : match[2] !== undefined
                      ? match[2].replace(/''/g, "'")
                      : (match[3] ?? "").trim();
            entries.push({ key, lines: [line] });
            continue;
        }

        const last = entries.at(-1);

        if (last) {
            last.lines.push(line);
        } else {
            entries.push({ key: null, lines: [line] });
        }
    }

    return entries;
}

/** Where a document's YAML front matter text sits, or null when it has none (JSON and TOML are not read). */
function yamlSpan(source: string): { start: number; end: number; entries: YamlEntry[] } | null {
    const match = source.match(FRONTMATTER_RE);

    if (!match || splitFrontmatter(source).format !== "yaml") {
        return null;
    }

    const start = source.indexOf("\n") + 1;
    const end = start + match[2]!.length;

    return { start, end, entries: yamlEntries(source.slice(start, end)) };
}

/** The top-level keys of a document's YAML front matter, or null when it has none. */
export function yamlFrontmatterKeys(source: string): string[] | null {
    const span = yamlSpan(source);

    if (!span) {
        return null;
    }

    return span.entries.flatMap((entry) => (entry.key === null ? [] : [entry.key]));
}

/**
 * The document with only the listed top-level front matter keys kept, every other byte unchanged. It undoes
 * {@link carryFrontmatterKeys}, so the text a generator wrote can be hashed while keys another tool added to the
 * block stay out of the hash.
 */
export function keepFrontmatterKeys(source: string, keep: ReadonlySet<string>): string {
    const span = yamlSpan(source);

    if (!span) {
        return source;
    }

    if (keep.size === 0) {
        // Remove exactly the closing delimiter and its newline, not whitespace in the body.
        return source.slice(span.end).replace(/^\r?\n---[ \t]*(?:\r?\n|$)/, "");
    }

    const kept = span.entries.filter((entry) => entry.key === null || keep.has(entry.key));

    if (kept.length === span.entries.length) {
        return source;
    }

    return `${source.slice(0, span.start)}${kept.flatMap((entry) => entry.lines).join("\n")}${source.slice(span.end)}`;
}

/**
 * The generated document with the existing file's front matter entries that the generator does not own appended
 * to its block, each byte for byte. A key the generated block sets is the generator's, and so is every key in
 * `owned` (the keys it wrote last time, so a key the document stopped setting goes away). If the generated
 * document has no front matter, a YAML block is created for the carried entries.
 */
export function carryFrontmatterKeys(
    generated: string,
    existing: string,
    owned: ReadonlySet<string> = new Set()
): { markdown: string; carried: string[] } {
    const target = yamlSpan(generated);
    const source = yamlSpan(existing);

    if (!source || (!target && splitFrontmatter(generated).format !== null)) {
        return { markdown: generated, carried: [] };
    }

    const generatorKeys = new Set([...owned, ...(yamlFrontmatterKeys(generated) ?? [])]);
    const carried = source.entries.filter(
        (entry): entry is YamlEntry & { key: string } => entry.key !== null && !generatorKeys.has(entry.key)
    );

    if (carried.length === 0) {
        return { markdown: generated, carried: [] };
    }

    const carriedLines = carried.flatMap((entry) => entry.lines);
    const markdown = target
        ? `${generated.slice(0, target.start)}${[generated.slice(target.start, target.end), ...carriedLines].join("\n")}${generated.slice(target.end)}`
        : `---\n${carriedLines.join("\n")}\n---\n${generated}`;

    return { markdown, carried: carried.map((entry) => entry.key) };
}
