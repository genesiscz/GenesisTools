import {
    type ApiDescriptor,
    jsonSchemaOf,
    type MethodDescriptor,
    methodSignature,
} from "@genesiscz/utils/api-descriptor";
import { SafeJSON } from "@genesiscz/utils/json";

function entries(apis: readonly ApiDescriptor[]) {
    return apis.flatMap((api) => [
        ...api.methods.map((method) => ({ owner: api.global, method })),
        ...(api.handles ?? []).flatMap((handle) =>
            handle.methods.map((method) => ({ owner: `${api.global}.${handle.name}`, method }))
        ),
    ]);
}

function fullDescriptor(owner: string, method: MethodDescriptor): string {
    return [
        methodSignature(owner, method),
        method.doc,
        `Effect: ${method.effect}`,
        `Parameters: ${SafeJSON.stringify(jsonSchemaOf(method.params), null, 2)}`,
        `Result: ${SafeJSON.stringify(jsonSchemaOf(method.result, "output"), null, 2)}`,
        `MCP: ${SafeJSON.stringify(method.mcp ?? {})}`,
    ].join("\n");
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
            .map(({ owner, method }) => `${methodSignature(owner, method)} [${method.effect}] — ${method.doc}`)
            .join("\n") || "No matching methods in the loaded toolsets."
    );
}

export function describeMethod(apis: readonly ApiDescriptor[], name: string): string {
    const matches = entries(apis).filter(
        ({ owner, method }) => `${owner}.${method.name}` === name || method.name === name
    );

    if (matches.length !== 1) {
        throw new Error(
            matches.length === 0 ? `Unknown method: ${name}` : `Ambiguous method: ${name}; use a fully qualified name.`
        );
    }

    return fullDescriptor(matches[0].owner, matches[0].method);
}
