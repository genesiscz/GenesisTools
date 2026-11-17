/**
 * The minimal printer of P1: text or JSON. P2 replaces it with the output layer's `emit` and the formatter table.
 */
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { NextAction, Reply } from "@genesiscz/utils/output/reply";

function kebab(key: string): string {
    return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function quote(value: string): string {
    return /^[\w:./@#,-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

/** A next action as the command line of this door. */
export function commandOf(call: NonNullable<NextAction["call"]>): string {
    const parts = ["tools", "work", call.method];
    const params = { ...call.params };

    for (const key of ["ref", "refs", "title"]) {
        const value = params[key];

        if (value === undefined) {
            continue;
        }

        parts.push(quote(Array.isArray(value) ? value.join(",") : String(value)));
        delete params[key];
    }

    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === false) {
            continue;
        }

        if (value === true) {
            parts.push(`--${kebab(key)}`);
            continue;
        }

        parts.push(`--${kebab(key)}`, quote(Array.isArray(value) ? value.join(",") : String(value)));
    }

    return parts.join(" ");
}

export interface EmitFlags {
    json?: boolean;
}

/** Prints a reply: the result on stdout, diagnostics and next actions on stderr, exit code 1 when it failed. */
export function emit<T>(reply: Reply<T>, flags: EmitFlags, text: (data: T) => string[]): void {
    if (flags.json) {
        out.result(reply);
    } else if (reply.ok) {
        const lines = text(reply.data);

        if (reply.dryRun) {
            lines.unshift("(dry run: nothing was written)");
        }

        if (reply.receipt?.replayed) {
            lines.unshift(`(replayed the stored reply of request ${reply.receipt.requestId ?? "?"})`);
        }

        if (lines.length > 0) {
            out.print(`${lines.join("\n")}\n`);
        }
    }

    if (!flags.json) {
        for (const diagnostic of reply.diagnostics) {
            out.printlnErr(`${diagnostic.severity}: ${diagnostic.code}: ${diagnostic.message}`);
        }

        for (const next of reply.next) {
            const how = next.call ? commandOf(next.call) : (next.ask ?? "");
            out.printlnErr(`next: ${next.do}${how ? `: ${how}` : ""}`);
        }
    }

    if (!reply.ok) {
        process.exitCode = 1;
    }
}

export function jsonLine(value: unknown): string {
    return SafeJSON.stringify(value);
}
