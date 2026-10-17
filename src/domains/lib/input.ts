import { parseVariadic } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";

/** Names from args, a `--file` (one per line, # comments), and piped stdin, in that order. */
export async function gatherNames({ args, file }: { args: string[]; file?: string }): Promise<string[]> {
    const names = parseVariadic(args).flatMap((arg) => arg.split(/\s+/));
    if (file) {
        names.push(...splitLines(await Bun.file(file).text()));
    }

    if (names.length === 0 && !process.stdin.isTTY) {
        names.push(...splitLines(await Bun.stdin.text()));
    }

    return names.filter(Boolean);
}

function splitLines(text: string): string[] {
    return text
        .split("\n")
        .map((line) => line.replace(/#.*$/, "").trim())
        .filter(Boolean);
}

export function parseMoney(value: string | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    const amount = Number.parseFloat(value.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(amount)) {
        throw new Error(`Not a price: "${value}"`);
    }

    return amount;
}

export function reportInvalid(invalid: string[]): void {
    if (invalid.length) {
        out.log.warn(`Skipped ${invalid.length} invalid name(s): ${invalid.slice(0, 8).join(", ")}`);
    }
}
