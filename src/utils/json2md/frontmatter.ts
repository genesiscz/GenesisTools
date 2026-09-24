/**
 * Front matter in YAML, JSON or TOML.
 *
 * The YAML emitter is written by hand on purpose. `yaml` and `js-yaml` are present in this
 * repo only as transitive packages, and adding either as a direct dependency would also add
 * it to a sibling repo's vendor set. Emitting the small subset front matter actually uses is
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
