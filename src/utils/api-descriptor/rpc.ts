import { JSON_RPC_ERRORS, RpcError } from "@genesiscz/utils/rpc/errors";
import type { z } from "zod";
import type { MethodDescriptor } from "./descriptor";

/** Anything with a method list: an API, or one handle of it (`Movie`). */
export interface MethodTable {
    methods: readonly MethodDescriptor[];
}

export type MethodName<A extends MethodTable> = A["methods"][number]["name"];
type MethodNamed<A extends MethodTable, N> = Extract<A["methods"][number], { name: N }>;

/** One method's handler: its params as its schema outputs them, and the caller's context. */
export type RpcHandler<M extends MethodDescriptor, C> = (params: z.output<M["params"]>, context: C) => unknown;

/** One handler per method name; a descriptor whose names are literals makes a missing one a compile error. */
export type RpcHandlers<A extends MethodTable, C> = {
    [N in MethodName<A>]: RpcHandler<MethodNamed<A, N>, C>;
};

/** JSON-RPC methods made from a descriptor: each call is validated against its method's schema, then handled. */
export interface RpcTable<C> {
    /** The JSON-RPC names, with the prefix. */
    readonly methods: readonly string[];
    has(method: string): boolean;
    /** Refuses an unknown name (`methodNotFound`) and params the schema rejects (`invalidParams`, with its message). */
    call(method: string, params: unknown, context: C): Promise<unknown>;
}

function issuesOf(error: z.ZodError): string {
    return error.issues
        .map((issue) => `${issue.path.length ? issue.path.join(".") : "params"}: ${issue.message}`)
        .join("; ");
}

/** `toRpcTable(api, handlers, { prefix: "movie." })` answers `movie.split { at }` with the handler of `split`. */
export function toRpcTable<A extends MethodTable, C = undefined>(
    api: A,
    handlers: RpcHandlers<NoInfer<A>, C>,
    options: { prefix?: string } = {}
): RpcTable<C> {
    const prefix = options.prefix ?? "";
    const byName = new Map(api.methods.map((method) => [`${prefix}${method.name}`, method]));
    const handlerOf = (name: string): RpcHandler<MethodDescriptor, C> | undefined => Reflect.get(handlers, name);

    return {
        methods: [...byName.keys()],
        has: (method) => byName.has(method),
        call: async (name, params, context) => {
            const method = byName.get(name);
            const handler = method ? handlerOf(method.name) : undefined;

            if (!method || !handler) {
                throw new RpcError(JSON_RPC_ERRORS.methodNotFound, `unknown method ${name}`);
            }

            const parsed = method.params.safeParse(params ?? {});

            if (!parsed.success) {
                throw new RpcError(JSON_RPC_ERRORS.invalidParams, `${name}: ${issuesOf(parsed.error)}`);
            }

            return handler(parsed.data, context);
        },
    };
}

/** The arguments a handle's method takes for one params object: its positional values in order, else the object. */
export function callArguments(method: MethodDescriptor, params: unknown): unknown[] {
    return method.positional && params !== null && typeof params === "object"
        ? method.positional.map((key) => Reflect.get(params, key))
        : [params];
}

/**
 * Handlers that call the method of the same name on the object `target` gives for the call's context, the way the
 * REPL calls a handle (`Movie`): positional methods get their values in order.
 */
export function handleHandlers<A extends MethodTable, C>(
    api: A,
    target: (context: C) => object | Promise<object>
): RpcHandlers<A, C> {
    const handlers: Record<string, RpcHandler<MethodDescriptor, C>> = {};

    for (const method of api.methods) {
        handlers[method.name] = async (params, context) => {
            const object = await target(context);
            const fn: unknown = Reflect.get(object, method.name);

            if (typeof fn !== "function") {
                throw new RpcError(JSON_RPC_ERRORS.methodNotFound, `${method.name} has no implementation`);
            }

            return Reflect.apply(fn, object, callArguments(method, params));
        };
    }

    // Every name of `api.methods` got its handler in the loop above.
    return handlers as RpcHandlers<A, C>;
}
