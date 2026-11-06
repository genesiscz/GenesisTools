import type { ApiDescriptor, MethodDescriptor } from "@genesiscz/utils/api-descriptor";
import { methodSignature, renderDocs, runInMethodScope } from "@genesiscz/utils/api-descriptor";
import { levenshteinDistance } from "@genesiscz/utils/fuzzy-match";
import type { ShowInput } from "./show";

/** What a toolset gets from the kernel when it is preloaded into a fresh worker. */
export interface ToolsetContext {
    recorder?: { start(options: unknown): Promise<string> };
    /** A private folder for this worker's life; the kernel removes it when the worker stops. */
    scratchDir: string;
    /** Returns an image to the model with the current turn's result. */
    show(input: ShowInput): Promise<void>;
    /** Adds a line to the current turn's text. */
    write(value: unknown): void;
}

/**
 * One preloadable REPL API: a global (or several) built once per kernel spawn, documented by its descriptor, and
 * disposed on reset and exit. A new toolset is one subclass and one line in the kernel's `REPL_TOOLSETS` table.
 */
/**
 * A method's Promise says so when it is printed as JSON: without `await`, JSON.stringify(movie.info()) wrote `{}`
 * and read as an empty answer (blind test, 2026-11-04).
 */
function markPromise(result: unknown, name: string): unknown {
    if (result instanceof Promise && !Object.hasOwn(result, "toJSON")) {
        Object.defineProperty(result, "toJSON", {
            value: () => `[a Promise: await ${name}(…) to get its value]`,
            enumerable: false,
        });
    }

    return result;
}

export abstract class ReplToolset {
    abstract readonly api: ApiDescriptor;

    get id(): string {
        return this.api.id;
    }

    get title(): string {
        return this.api.title;
    }

    get summary(): string {
        return this.api.summary;
    }

    /** The full API, as `help(id)` prints it. */
    docs(): string {
        return renderDocs(this.api);
    }

    /** The one line the `js` tool description carries. */
    oneLine(): string {
        return `${this.api.global}: ${this.api.summary}`;
    }

    /** Builds globals and checks calls at the REPL boundary using the same descriptors as help. */
    async load(ctx: ToolsetContext): Promise<Record<string, unknown>> {
        const globals = await this.bootstrap(ctx);
        const value = globals[this.api.global];
        if (value !== null && typeof value === "object") {
            globals[this.api.global] = this.bindMethods({
                target: value,
                methods: this.api.methods,
                owner: this.api.global,
            });
        }
        return globals;
    }

    private bindMethods({
        target,
        methods,
        owner,
        prefix = "",
    }: {
        target: object;
        methods: readonly MethodDescriptor[];
        owner: string;
        prefix?: string;
    }): object {
        return new Proxy(target, {
            get: (object, property) => {
                const value: unknown = Reflect.get(object, property, object);
                const name = prefix + String(property);
                const method = methods.find((candidate) => candidate.name === name);
                if (method && typeof value === "function") {
                    return (...args: unknown[]) => {
                        const input = method.positional
                            ? Object.fromEntries(method.positional.map((key, index) => [key, args[index]]))
                            : args[0] === undefined
                              ? {}
                              : args[0];
                        // An AbortSignal rides beside the options: the descriptor does not list it, and the method
                        // gets it back after validation.
                        let schemaInput = input;
                        let signal: AbortSignal | undefined;

                        if (
                            !method.positional &&
                            typeof input === "object" &&
                            input !== null &&
                            "signal" in input &&
                            input.signal instanceof AbortSignal
                        ) {
                            const { signal: reserved, ...rest } = input;
                            signal = reserved;
                            schemaInput = rest;
                        }

                        let parsed = method.params.safeParse(schemaInput);
                        // cut({ from, to }) for cut(from, to): one plain object whose keys are all parameter names is
                        // taken as the named arguments, when the positional reading of it fails.
                        const named = args[0];
                        if (
                            !parsed.success &&
                            method.positional &&
                            args.length === 1 &&
                            named !== null &&
                            typeof named === "object" &&
                            !Array.isArray(named) &&
                            Object.keys(named).length > 0 &&
                            Object.keys(named).every((key) => method.positional?.includes(key))
                        ) {
                            const again = method.params.safeParse(named);
                            if (again.success) {
                                parsed = again;
                            }
                        }
                        if (!parsed.success || args.length > (method.positional?.length ?? 1)) {
                            const problems = parsed.success
                                ? [`too many arguments (${args.length})`]
                                : parsed.error.issues.map(
                                      (issue) =>
                                          `${issue.path.length ? issue.path.join(".") : "options"}: ${issue.message}`
                                  );
                            const error = new TypeError(
                                `Invalid arguments for ${owner}.${name}:\n${problems.map((line) => `  - ${line}`).join("\n")}\nExpected ${methodSignature(owner, method)}`
                            );

                            // An async method's caller may use .catch(); a throw at the call would skip it.
                            if (value.constructor?.name === "AsyncFunction") {
                                return Promise.reject(error);
                            }

                            throw error;
                        }
                        const params =
                            signal && typeof parsed.data === "object" && parsed.data !== null
                                ? { ...parsed.data, signal }
                                : parsed.data;
                        const callArgs =
                            method.positional && params !== null && typeof params === "object"
                                ? method.positional.map((key) => Reflect.get(params, key))
                                : [params];
                        // The scope lets assertReach() below this call refuse a reach the method does not declare.
                        const result = runInMethodScope({ name: `${owner}.${name}`, method }, () =>
                            Reflect.apply(value, object, callArgs)
                        );
                        return markPromise(this.bindResult({ result, name: method.resultName }), `${owner}.${name}`);
                    };
                }
                if (
                    value !== null &&
                    typeof value === "object" &&
                    methods.some((method) => method.name.startsWith(`${name}.`))
                ) {
                    return this.bindMethods({ target: value, methods, owner, prefix: `${name}.` });
                }

                // `movies.help()` and `movie.help()` are the first guesses of a model: the same docs as help("movies").
                if (property === "help" && value === undefined && !("help" in object)) {
                    return () => this.docs();
                }

                // A misspelled or guessed method would be `undefined`, and the call "x is not a function"; name the
                // real ones instead. Only a plain name the object lacks throws, so inspection and `await` still work.
                if (
                    value === undefined &&
                    typeof property === "string" &&
                    !(property in object) &&
                    !PROBED.has(property)
                ) {
                    const known = methods
                        .filter(
                            (method) =>
                                method.name.startsWith(prefix) && !method.name.slice(prefix.length).includes(".")
                        )
                        .map((method) => method.name.slice(prefix.length));
                    const close = known.filter(
                        (candidate) =>
                            levenshteinDistance(candidate.toLowerCase(), property.toLowerCase()) <= 2 ||
                            candidate.toLowerCase().startsWith(property.toLowerCase())
                    );
                    throw new TypeError(
                        `${owner}${prefix ? `.${prefix.slice(0, -1)}` : ""} has no "${property}"${close.length ? ` (did you mean ${close.join(", ")}?)` : ""}; it has: ${known.join(", ")}`
                    );
                }
                return typeof value === "function" ? value.bind(object) : value;
            },
        });
    }

    private bindResult({ result, name }: { result: unknown; name?: string }): unknown {
        const jobHandle = name?.match(/^Job<([^>]+)>$/)?.[1];
        const handle = this.api.handles?.find((candidate) => candidate.name === (jobHandle ?? name));
        if (!handle) {
            return result;
        }
        const bind = (value: unknown) =>
            value !== null && typeof value === "object"
                ? this.bindMethods({
                      target: value,
                      methods: handle.methods,
                      owner: `${this.api.global}.${handle.name}`,
                  })
                : value;
        if (result instanceof Promise) {
            return result.then(bind);
        }
        if (jobHandle && result !== null && typeof result === "object") {
            const done: unknown = Reflect.get(result, "done");
            if (done instanceof Promise) {
                const mapped = done.then(bind);
                return new Proxy(result, {
                    get: (object, property) => {
                        if (property === "done") {
                            return mapped;
                        }
                        if (property === "then") {
                            return mapped.then.bind(mapped);
                        }
                        const value: unknown = Reflect.get(object, property, object);
                        return typeof value === "function" ? value.bind(object) : value;
                    },
                });
            }
        }
        return bind(result);
    }

    /** Builds the globals inside the worker; runs once per spawn, outside every turn's timeout. */
    abstract bootstrap(ctx: ToolsetContext): Promise<Record<string, unknown>>;

    /** Releases what `bootstrap` started (a recording, a native session). */
    async dispose(): Promise<void> {}
}

export type ReplToolsetFactory = () => ReplToolset;

/** Names that inspection, `await`, JSON and test matchers read off any object; a missing one is not a mistake. */
const PROBED = new Set([
    "then",
    "catch",
    "finally",
    "toJSON",
    "toString",
    "valueOf",
    "constructor",
    "inspect",
    "length",
    "name",
    "prototype",
    "asymmetricMatch",
    "$$typeof",
    "nodeType",
    "tagName",
    "size",
    "stack",
    "message",
    "cause",
]);
