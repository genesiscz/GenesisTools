/**
 * Commander commands made from a method table: one command per method, the named keys as positional words, every
 * other key as one flag. Params must stay flat for this: a key is a flag.
 */
import type { Command } from "commander";
import type { ApiDescriptor, MethodDescriptor } from "./descriptor";
import { type JsonSchema, jsonSchemaOf } from "./render";

export interface CliOption {
    flags: string;
    description: string;
    defaultValue?: string;
}

export interface CliCommandsOptions {
    /** The keys a method takes as words, in order (`spot <title>`). */
    positional?: Partial<Record<string, readonly string[]>>;
    /** Flags that are not params (output format, request id): added to each command, passed to `run` as `extra`. */
    extra?: (method: MethodDescriptor) => CliOption[];
    run(method: string, params: Record<string, unknown>, extra: Record<string, unknown>): Promise<void>;
}

function kebab(key: string): string {
    return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function camel(flag: string): string {
    return flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function kindOf(schema: JsonSchema): "boolean" | "number" | "array" | "string" {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];

    if (types.includes("boolean")) {
        return "boolean";
    }

    if (types.includes("array")) {
        return "array";
    }

    if (types.includes("integer") || types.includes("number")) {
        return "number";
    }

    return "string";
}

function valuesOf(schema: JsonSchema): unknown[] | undefined {
    if (schema.enum !== undefined) {
        return schema.enum;
    }

    const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
    return items?.enum;
}

function describe(schema: JsonSchema & { description?: string }): string {
    const values = valuesOf(schema);
    const text = schema.description ?? "";
    return values !== undefined ? `${text}${text ? "; " : ""}${values.join("|")}` : text;
}

function coerce(kind: ReturnType<typeof kindOf>, raw: unknown): unknown {
    if (kind === "array" && typeof raw === "string") {
        return raw
            .split(",")
            .map((v) => v.trim())
            .filter((v) => v.length > 0);
    }

    if (kind === "boolean" && (raw === "true" || raw === "false")) {
        return raw === "true";
    }

    if (kind === "number" && typeof raw === "string") {
        return Number(raw);
    }

    return raw;
}

/** Adds one command per method to `program` and returns them by method name, so a door can add subcommands. */
export function toCliCommands(api: ApiDescriptor, program: Command, options: CliCommandsOptions): Map<string, Command> {
    const commands = new Map<string, Command>();

    for (const method of api.methods) {
        const schema = jsonSchemaOf(method.params);
        const properties = (schema.properties ?? {}) as Record<string, JsonSchema & { description?: string }>;
        const required = new Set(schema.required ?? []);
        const words = options.positional?.[method.name] ?? [];
        const command = program.command(method.name).description(method.doc);

        for (const word of words) {
            const property = properties[word] ?? {};
            const many = kindOf(property) === "array";
            command.argument(
                required.has(word) ? `<${word}>` : `[${word}]`,
                `${describe(property)}${many ? " (comma-separated)" : ""}`
            );
        }

        for (const [key, property] of Object.entries(properties)) {
            if (words.includes(key)) {
                continue;
            }

            const kind = kindOf(property);
            const flag =
                kind === "boolean"
                    ? `--${kebab(key)} [true|false]`
                    : `--${kebab(key)} <${kind === "array" ? `${key},…` : key}>`;

            if (required.has(key) && kind !== "boolean") {
                command.requiredOption(flag, describe(property));
            } else {
                command.option(flag, describe(property));
            }
        }

        const extras = options.extra?.(method) ?? [];
        const extraKeys = new Set<string>();

        for (const extra of extras) {
            command.option(extra.flags, extra.description, extra.defaultValue);
            const long = /--([a-z][a-z-]*)/.exec(extra.flags)?.[1];

            if (long !== undefined) {
                extraKeys.add(camel(long));
            }
        }

        command.action(async (...args: unknown[]) => {
            const opts = (args[words.length] ?? {}) as Record<string, unknown>;
            const params: Record<string, unknown> = {};
            const extra: Record<string, unknown> = {};

            words.forEach((word, index) => {
                if (args[index] !== undefined) {
                    params[word] = coerce(kindOf(properties[word] ?? {}), args[index]);
                }
            });

            for (const [key, value] of Object.entries(opts)) {
                if (extraKeys.has(key)) {
                    extra[key] = value;
                } else if (properties[key] !== undefined) {
                    params[key] = coerce(kindOf(properties[key]), value);
                }
            }

            await options.run(method.name, params, extra);
        });
        commands.set(method.name, command);
    }

    return commands;
}
