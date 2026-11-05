import {
    type ApiDescriptor,
    jsonSchemaOf,
    type MethodDescriptor,
    methodSignature,
} from "@genesiscz/utils/api-descriptor";
import { SafeJSON } from "@genesiscz/utils/json";

function entries(apis: readonly ApiDescriptor[]) {
    return apis.flatMap((api) => [
        ...api.methods.map((method) => ({ owner: api.global, alias: api.global, method })),
        ...(api.handles ?? []).flatMap((handle) =>
            handle.methods.map((method) => ({
                owner: `${api.global}.${handle.name}`,
                alias: handle.name.charAt(0).toLowerCase() + handle.name.slice(1),
                method,
            }))
        ),
    ]);
}

/** A result schema that says nothing (z.unknown()) is only its `$schema` key. */
function saysNothing(schema: unknown): boolean {
    return typeof schema === "object" && schema !== null && Object.keys(schema).every((key) => key === "$schema");
}

function fullDescriptor(owner: string, method: MethodDescriptor): string {
    const result = jsonSchemaOf(method.result, "output");
    const resultLine = saysNothing(result)
        ? `Result: ${method.resultName ?? "unknown"}`
        : `Result: ${method.resultName ? `${method.resultName} ` : ""}${SafeJSON.stringify(result, null, 2)}`;
    return [
        methodSignature(owner, method),
        method.doc,
        `Effect: ${method.effect}`,
        `Parameters: ${SafeJSON.stringify(jsonSchemaOf(method.params), null, 2)}`,
        resultLine,
        ...(method.mcp && Object.keys(method.mcp).length ? [`MCP: ${SafeJSON.stringify(method.mcp)}`] : []),
    ].join("\n");
}

/** A line spells a signature out up to this length; a longer one (an op list of 60 kinds) goes one level deep. */
const LINE_SIGNATURE_MAX = 600;

/** One method as search and a listing print it: its own signature, its effect and its doc. */
function methodLine(owner: string, method: MethodDescriptor): string {
    const full = methodSignature(owner, method);
    const signature =
        full.length <= LINE_SIGNATURE_MAX
            ? full
            : `${methodSignature(owner, method, 1)} (describe("${owner}.${method.name}") prints it in full)`;
    return `${signature} [${method.effect}] — ${method.doc}`;
}

/** One line per method of an owner (`movies`, `movies.Movie`, or its alias `movie`), like search's lines. */
function ownerListing(list: ReturnType<typeof entries>, owner: string): string {
    return list
        .filter((entry) => entry.owner === owner)
        .map(({ method }) => methodLine(owner, method))
        .join("\n");
}

export function searchMethods(apis: readonly ApiDescriptor[], query: string): string {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return (
        entries(apis)
            .filter(({ owner, method }) => {
                const text =
                    `${owner}.${method.name} ${method.doc} ${SafeJSON.stringify(jsonSchemaOf(method.params))}`.toLowerCase();
                return terms.every((term) => text.includes(term));
            })
            .map(({ owner, method }) => methodLine(owner, method))
            .join("\n") || "No matching methods in the loaded toolsets."
    );
}

/**
 * One method in full (`movies.open`, `movies.Movie.cut`, its alias `movie.cut`, or a bare `cut` when only one
 * method has the name), or every method of a toolset or object (`movies`, `movies.Movie`, `Movie`, `movie`).
 * With no name it lists every toolset and object with its method names.
 */
export function describeMethod(apis: readonly ApiDescriptor[], name?: string): string {
    const list = entries(apis);
    const owners = [...new Set(list.map((entry) => entry.owner))];
    const index = owners
        .map(
            (owner) =>
                `${owner}: ${list
                    .filter((entry) => entry.owner === owner)
                    .map((entry) => entry.method.name)
                    .join(", ")}`
        )
        .join("\n");

    if (name === undefined || name.trim() === "") {
        return `${index}\n\ndescribe("<owner>") lists one of them with docs; describe("<owner>.<method>") prints one in full.`;
    }

    const wanted = name.trim();
    const owner = owners.find(
        (one) =>
            one === wanted ||
            one.split(".").at(-1) === wanted ||
            list.some((entry) => entry.owner === one && entry.alias === wanted && entry.alias !== entry.owner)
    );

    if (owner) {
        return ownerListing(list, owner);
    }

    const matches = list.filter(
        ({ owner, alias, method }) =>
            `${owner}.${method.name}` === wanted || `${alias}.${method.name}` === wanted || method.name === wanted
    );

    if (matches.length === 1) {
        return fullDescriptor(matches[0].owner, matches[0].method);
    }

    if (matches.length > 1) {
        throw new Error(
            `Ambiguous method: ${wanted}; use one of ${matches.map((entry) => `${entry.owner}.${entry.method.name}`).join(", ")}`
        );
    }

    throw new Error(`Unknown method: ${wanted}. The loaded names:\n${index}`);
}
