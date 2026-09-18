import { existsSync } from "node:fs";
import type { CommandOption } from "@app/tools/lib/introspect";

export interface FlagBinding {
    flag: string;
    value?: string;
    omitted?: string;
}

function flagName(flags: string): string {
    const long = flags.match(/--([a-z0-9-]+)/i);
    return long?.[1] ?? flags;
}

export function spanInUtterance(utterance: string, value: string): boolean {
    return utterance.includes(value);
}

export function bindFlagValue(options: {
    utterance: string;
    flags: string;
    proposed: string;
    enums?: string[];
    file?: boolean;
}): FlagBinding {
    const flag = `--${flagName(options.flags)}`;
    if (!spanInUtterance(options.utterance, options.proposed)) {
        return { flag, omitted: "not-in-utterance" };
    }
    if (options.enums && !options.enums.includes(options.proposed)) {
        return { flag, omitted: "enum-mismatch" };
    }
    if (options.file && options.proposed !== "-" && !existsSync(options.proposed)) {
        return { flag, omitted: "missing-path" };
    }
    return { flag, value: options.proposed };
}

export function applyBindings(argv: string[], bindings: FlagBinding[]): { argv: string[]; warnings: string[] } {
    const warnings: string[] = [];
    const next = [...argv];
    for (const binding of bindings) {
        if (binding.omitted) {
            warnings.push(`${binding.flag}: ${binding.omitted}`);
            continue;
        }
        if (binding.value !== undefined) {
            next.push(binding.flag, binding.value);
        }
    }
    return { argv: next, warnings };
}

export function optionLongNames(options: CommandOption[]): string[] {
    return options.map((option) => flagName(option.flags));
}
