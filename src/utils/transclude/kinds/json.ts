import { SafeJSON } from "@genesiscz/utils/json";
import { defineTransclusion, TransclusionError } from "../registry";
import { caption, codeBlock, provenanceMeta, readSource, sourceIdentity } from "./shared";

/**
 * A pointer as path segments. `/a/b/0` is RFC 6901 (`~1` is `/`, `~0` is `~`); `$.a.b[0]` and
 * `$["a b"]` are the JSONPath subset agents type; a bare `a.b.0` is read as dots.
 */
export function pointerSegments(pointer: string): string[] {
    const trimmed = pointer.trim();

    // RFC 6901: "" is the root; "/" is the property with the empty-string key.
    if (trimmed === "" || trimmed === "$") {
        return [];
    }

    if (trimmed.startsWith("/")) {
        return trimmed
            .slice(1)
            .split("/")
            .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    }

    const body = trimmed.startsWith("$") ? trimmed.slice(1) : `.${trimmed}`;
    const segments: string[] = [];
    const pattern = /\.([^.[\]]+)|\[(\d+)\]|\[(["'])((?:\\.|(?!\3).)*)\3\]/gy;
    let match = pattern.exec(body);

    while (match) {
        segments.push(match[1] ?? match[2] ?? match[4].replace(/\\(.)/g, "$1"));

        if (pattern.lastIndex === body.length) {
            return segments;
        }

        match = pattern.exec(body);
    }

    throw new TransclusionError(`cannot read pointer "${pointer}" (use /a/b/0 or $.a.b[0])`);
}

export function followPointer(root: unknown, segments: string[], pointer: string): unknown {
    let value = root;
    const walked: string[] = [];

    for (const segment of segments) {
        const at = walked.length ? `/${walked.join("/")}` : "the root";

        if (Array.isArray(value)) {
            const index = Number(segment);

            if (!Number.isInteger(index) || index < 0 || index >= value.length) {
                throw new TransclusionError(
                    `pointer "${pointer}": no index ${segment} in ${at} (${value.length} items)`
                );
            }

            value = value[index];
        } else if (value && typeof value === "object") {
            const record = value as Record<string, unknown>;

            if (!Object.hasOwn(record, segment)) {
                const keys = Object.keys(record).slice(0, 12).join(", ");
                throw new TransclusionError(`pointer "${pointer}": "${segment}" missing in ${at} (keys: ${keys})`);
            }

            value = record[segment];
        } else {
            throw new TransclusionError(`pointer "${pointer}": ${at} is a ${typeof value}, not an object or array`);
        }

        walked.push(segment);
    }

    return value;
}

export const jsonTransclusion = defineTransclusion({
    name: "json",
    description:
        "One value out of a JSON (or JSONC) file, pretty-printed. pointer is a JSON Pointer (/a/b/0) or a " +
        "$.a.b[0] path; comments and trailing commas in the file are fine.",
    params: [
        { name: "path", type: "path", required: true, description: "The JSON file." },
        {
            name: "pointer",
            type: "string",
            default: "",
            description: "/a/b/0 or $.a.b[0]; empty means the whole file.",
        },
        { name: "commit", type: "string", description: "Read the file at this commit." },
    ],
    examples: [
        '{{json path="package.json" pointer="/scripts/test"}}',
        '{{json path="biome.json" pointer="$.formatter"}}',
    ],
    action: "substitute",
    async resolve(params, ctx) {
        const path = params.string("path");
        const pointer = params.string("pointer");
        const source = await readSource({ path, commit: params.optionalString("commit"), ctx });
        let root: unknown;

        try {
            root = SafeJSON.parse(source.text);
        } catch (error) {
            throw new TransclusionError(
                `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        const value = followPointer(root, pointerSegments(pointer), pointer);
        return {
            markdown: codeBlock({
                text: SafeJSON.stringify(value, null, 2) ?? "undefined",
                lang: "json",
                title: caption({ path, provenance: source.provenance, suffix: pointer || undefined }),
            }),
            meta: { ...provenanceMeta(source.provenance), pointer },
            block: true,
            source: sourceIdentity({ path, provenance: source.provenance }),
        };
    },
});
