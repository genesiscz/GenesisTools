import type { ApiDescriptor, MethodDescriptor } from "@genesiscz/utils/api-descriptor";
import { methodSignature, renderDocs } from "@genesiscz/utils/api-descriptor";
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
                        const parsed = method.params.safeParse(input);
                        if (!parsed.success || args.length > (method.positional?.length ?? 1)) {
                            throw new TypeError(
                                `Invalid arguments for ${owner}.${name}. Expected ${methodSignature(owner, method)}. ${parsed.success ? "Too many arguments." : parsed.error.message}`
                            );
                        }
                        const params = parsed.data;
                        const callArgs =
                            method.positional && params !== null && typeof params === "object"
                                ? method.positional.map((key) => Reflect.get(params, key))
                                : [params];
                        return this.bindResult({
                            result: Reflect.apply(value, object, callArgs),
                            name: method.resultName,
                        });
                    };
                }
                if (
                    value !== null &&
                    typeof value === "object" &&
                    methods.some((method) => method.name.startsWith(`${name}.`))
                ) {
                    return this.bindMethods({ target: value, methods, owner, prefix: `${name}.` });
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
