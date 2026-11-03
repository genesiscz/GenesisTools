import type { z } from "zod";

/** What a call does to the world: `read` changes nothing, `reversible` can be undone by another call, `destructive` cannot. */
export const METHOD_EFFECTS = ["read", "reversible", "destructive"] as const;
export type MethodEffect = (typeof METHOD_EFFECTS)[number];

/** One callable method, described once: the REPL help, the MCP tool list and CLI help are generated from it. */
export interface MethodDescriptor<P extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
    /** `start`, or a dotted name for a nested member: `displays.switch`. */
    name: string;
    params: P;
    result: R;
    /** One line, present tense. */
    doc: string;
    effect: MethodEffect;
    /** The result's type name when the schema cannot spell it (`Recording`, `ComputerState`). */
    resultName?: string;
    /** Takes the params as positional arguments in this order instead of one object (`sleep(ms)`). */
    positional?: readonly string[];
    mcp?: {
        /** Reaches beyond the local machine's state (a model call, the network). Default: any non-read call. */
        openWorld?: boolean;
    };
}

/** A handle object a method returns, with methods of its own (`Recording` from `recorder.start`). */
export interface HandleDescriptor {
    name: string;
    summary: string;
    methods: readonly MethodDescriptor[];
}

/** One API surface: a REPL toolset's global, or an MCP server's tool set. */
export interface ApiDescriptor {
    id: string;
    /** The REPL global the methods hang off (`recorder`); an MCP server ignores it. */
    global: string;
    title: string;
    /** One line. */
    summary: string;
    methods: readonly MethodDescriptor[];
    handles?: readonly HandleDescriptor[];
    /** Short facts a caller needs that no single method carries. */
    notes?: readonly string[];
}

/** Keeps the schemas' types for the caller while checking the descriptor's shape. */
export function defineMethod<P extends z.ZodType, R extends z.ZodType>(
    method: MethodDescriptor<P, R>
): MethodDescriptor<P, R> {
    return method;
}

export function defineApi<A extends ApiDescriptor>(api: A): A {
    const names = new Set<string>();

    for (const method of api.methods) {
        if (names.has(method.name)) {
            throw new Error(`API ${api.id} describes ${method.name} twice`);
        }

        names.add(method.name);
    }

    return api;
}
