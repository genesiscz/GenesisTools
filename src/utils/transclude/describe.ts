import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { TransclusionRegistry } from "./registry";
import type { TransclusionDefinition, TransclusionParam } from "./types";

/** The grammar in four lines, shared by the CLI help, the MCP description and the README check. */
export const TRANSCLUSION_GRAMMAR = [
    "{{<kind> key=\"value\" key='value' key=value}}: named params in any order, resolved when the text is saved.",
    "A token always has at least one key=value; a bare {{name}} is a prompt variable and stays literal.",
    "Inside quotes only \\\" \\' \\\\ are escapes, so C:\\path needs no doubling. \\{{ writes a literal {{.",
    "Tokens inside `code` or a fenced block stay literal. mdBook aliases: {{#include path}}, {{#include path:10:20}}, {{#include path:anchor}}.",
    "A token that fails is replaced by ⚠️ unresolved `{{…}}`: <reason>, never dropped.",
    "Each block ends with a footer: capture time, source, what is shown, and the token that re-checks it.",
    `[verify] kinds stay live: ${toolCommand("question show")} <id> --recheck reports whether they changed since capture.`,
];

export interface TransclusionDescription {
    name: string;
    description: string;
    action: string;
    params: Array<Omit<TransclusionParam, "values"> & { values?: string[] }>;
    requireOneOf?: string[][];
    examples: string[];
}

/** The definitions as plain data, for `--format json` and the MCP tool. */
export function describeTransclusions(registry: TransclusionRegistry): TransclusionDescription[] {
    return registry.list().map((definition) => ({
        name: definition.name,
        description: definition.description,
        action: definition.action ?? "substitute",
        params: definition.params.map(({ values, ...param }) => ({
            ...param,
            ...(values ? { values: [...values] } : {}),
        })),
        ...(definition.requireOneOf ? { requireOneOf: definition.requireOneOf } : {}),
        examples: definition.examples,
    }));
}

/** `path*` required, `n=50` defaulted, `staged:bool`: one compact line of params. */
export function formatParamList(definition: TransclusionDefinition): string {
    return definition.params
        .map((param) => {
            const required = param.required ? "*" : "";
            const fallback = param.default !== undefined && param.default !== "" ? `=${String(param.default)}` : "";
            const type = param.type === "string" || param.type === "path" ? "" : `:${param.type}`;
            return `${param.name}${required}${type}${fallback}`;
        })
        .join(" ");
}

/** The kind name, with `[verify]` after the kinds that stay live. */
function label(definition: TransclusionDefinition): string {
    return definition.action === "verify" ? `${definition.name} [verify]` : definition.name;
}

function oneOfNote(definition: TransclusionDefinition): string {
    return (definition.requireOneOf ?? []).map((group) => ` (one of ${group.join("|")})`).join("");
}

/**
 * The help block for a CLI or a tool description: the grammar, then every kind with its params and
 * its first example. Generated from the registry, so a new kind shows up without editing any copy.
 */
export function formatTransclusionHelp(
    registry: TransclusionRegistry,
    { indent = "  ", descriptions = true }: { indent?: string; descriptions?: boolean } = {}
): string {
    const width = Math.max(...registry.list().map((definition) => definition.name.length));
    const lines = TRANSCLUSION_GRAMMAR.map((line) => `${indent}${line}`);
    lines.push(`${indent}Kinds (* required, :type, =default):`);

    for (const definition of registry.list()) {
        const params = `${formatParamList(definition)}${oneOfNote(definition)}`;

        if (!descriptions) {
            lines.push(`${indent}  ${label(definition).padEnd(width + 9)}  ${params}  e.g. ${definition.examples[0]}`);
            continue;
        }

        lines.push(`${indent}  ${label(definition).padEnd(width + 9)}  ${definition.description}`);
        lines.push(`${indent}  ${" ".repeat(width + 9)}  params: ${params}`);
        lines.push(`${indent}  ${" ".repeat(width + 9)}  e.g. ${definition.examples[0]}`);
    }

    return lines.join("\n");
}
