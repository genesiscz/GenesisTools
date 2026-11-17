/** How the CLI door prints a next action: as the `tools work` command line that runs it. */
import type { Door } from "@genesiscz/utils/output/formatter";
import type { NextAction } from "@genesiscz/utils/output/reply";
import { WORK_CLI_POSITIONAL } from "@genesiscz/utils/work/api";

function kebab(key: string): string {
    return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function quote(value: string): string {
    return /^[\w:./@#,-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

function text(value: unknown): string {
    return quote(Array.isArray(value) ? value.join(",") : String(value));
}

export function commandOf(call: NonNullable<NextAction["call"]>): string {
    const parts = ["tools", "work", call.method];
    const params = { ...call.params };
    const words = Reflect.get(WORK_CLI_POSITIONAL, call.method) as readonly string[] | undefined;

    for (const key of words ?? []) {
        if (params[key] !== undefined) {
            parts.push(text(params[key]));
            delete params[key];
        }
    }

    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === false) {
            continue;
        }

        parts.push(...(value === true ? [`--${kebab(key)}`] : [`--${kebab(key)}`, text(value)]));
    }

    return parts.join(" ");
}

export const cliDoor: Door = { commandOf };
