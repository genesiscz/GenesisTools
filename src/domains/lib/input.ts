import { fstatSync } from "node:fs";
import { parseVariadic } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";

const STDIN_DEADLINE_MS = 10_000;

/** True when fd 0 is a pipe or a file; a TTY, a socket or /dev/null holds no list of names. */
function stdinHasInput(): boolean {
    try {
        const stat = fstatSync(0);
        return stat.isFIFO() || stat.isFile();
    } catch {
        return false;
    }
}

async function readStdin(): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), STDIN_DEADLINE_MS);
    });
    const text = await Promise.race([Bun.stdin.text(), deadline]);
    clearTimeout(timer);
    if (text === null) {
        out.log.warn(`stdin sent nothing for ${STDIN_DEADLINE_MS / 1000} s; pass names as arguments or --file`);
        return "";
    }

    return text;
}

/** Names from args, a `--file` (one per line, # comments), and piped stdin, in that order. */
export async function gatherNames({ args, file }: { args: string[]; file?: string }): Promise<string[]> {
    const names = parseVariadic(args).flatMap((arg) => arg.split(/\s+/));
    if (file) {
        names.push(...splitLines(await Bun.file(file).text()));
    }

    if (names.length === 0 && stdinHasInput()) {
        names.push(...splitLines(await readStdin()));
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
