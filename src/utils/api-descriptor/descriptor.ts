import type { z } from "zod";

/** What a call does to the world: `read` changes nothing, `reversible` can be undone by another call, `destructive` cannot. */
export const METHOD_EFFECTS = ["read", "reversible", "destructive"] as const;
export type MethodEffect = (typeof METHOD_EFFECTS)[number];

/**
 * Who else a call reaches, on an axis apart from its effect: `user` is something the user meets (a dialog or a
 * prompt, a window, a focus change, the clipboard, an inbox item), `paid` is a run billed to an account (a
 * transcription, a model call). A `read` method reaches neither; `assertReach()` refuses an undeclared reach at run time.
 */
export const METHOD_REACHES = ["user", "paid"] as const;
export type MethodReach = (typeof METHOD_REACHES)[number];

/** One callable method, described once for generated REPL help and MCP tool schemas. */
export interface MethodDescriptor<P extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
    /** `start`, or a dotted name for a nested member: `displays.switch`. */
    name: string;
    params: P;
    result: R;
    /** One line, present tense. */
    doc: string;
    effect: MethodEffect;
    /** Who else the call reaches (`METHOD_REACHES`); absent is none. */
    reaches?: readonly MethodReach[];
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

/** Keeps the schemas' types and the literal name for the caller while checking the descriptor's shape. */
export function defineMethod<P extends z.ZodType, R extends z.ZodType, const N extends string = string>(
    method: MethodDescriptor<P, R> & { name: N }
): MethodDescriptor<P, R> & { name: N } {
    // An agent calls a read method without asking; one that prompts the user or spends money is never read.
    if (method.effect === "read" && (method.reaches?.length ?? 0) > 0) {
        throw new Error(
            `${method.name} is read but reaches ${method.reaches?.join(", ")}; a read method reaches no one`
        );
    }

    return method;
}

/** `read`, or `reversible · user · paid`: the effect and the reaches, as help, search and describe print them. */
export function effectLabel(method: Pick<MethodDescriptor, "effect" | "reaches">): string {
    return [method.effect, ...(method.reaches ?? [])].join(" · ");
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
