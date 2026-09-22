import { suggestCommand } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import TOML from "@iarna/toml";
import { jsonrepair } from "jsonrepair";

export type InputFormat = "auto" | "json" | "jsonl" | "toml";

export const INPUT_FORMATS: readonly InputFormat[] = ["auto", "json", "jsonl", "toml"] as const;

export interface ReadInputOptions {
    /** A file path, `-` for stdin, or undefined to fall back to piped stdin. */
    arg: string | undefined;
    isTTY: boolean;
    format: InputFormat;
    /** Try `jsonrepair` when a parse fails. Default `false`, so a syntax error stays visible. */
    repair?: boolean;
}

export interface ReadInputResult {
    value: unknown;
    /** Where the text came from, for the log line and for error messages. */
    source: string;
    detected: Exclude<InputFormat, "auto">;
}

async function readText(arg: string | undefined, isTTY: boolean): Promise<{ text: string; source: string }> {
    const fromStdin = arg === "-" || (arg === undefined && !isTTY);

    if (fromStdin) {
        return { text: await Bun.stdin.text(), source: "stdin" };
    }

    if (arg === undefined) {
        throw new Error(
            `No input. Pass a file, "-", or pipe data in.\n${suggestCommand("tools json2md", { add: ["<file.json>"] })}`
        );
    }

    const file = Bun.file(arg);

    if (!(await file.exists())) {
        throw new Error(`File not found: ${arg}`);
    }

    return { text: await file.text(), source: arg };
}

/** Picks a format from the text itself when `--from auto`. */
function detectFormat(text: string, source: string): Exclude<InputFormat, "auto"> {
    if (source.endsWith(".jsonl") || source.endsWith(".ndjson")) {
        return "jsonl";
    }

    if (source.endsWith(".toml")) {
        return "toml";
    }

    const trimmed = text.trimStart();

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        const lines = text.split("\n").filter((line) => line.trim() !== "");
        const everyLineIsAnObject = lines.length > 1 && lines.every((line) => line.trimStart().startsWith("{"));

        return everyLineIsAnObject ? "jsonl" : "json";
    }

    return trimmed === "" ? "json" : "toml";
}

function parseJsonl(text: string, repair: boolean): unknown[] {
    const rows: unknown[] = [];

    text.split("\n").forEach((line, index) => {
        const trimmed = line.trim();

        if (trimmed === "") {
            return;
        }

        try {
            rows.push(SafeJSON.parse(trimmed, { strict: true }));
        } catch (error) {
            if (!repair) {
                throw new Error(
                    `Line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
                );
            }

            logger.debug({ line: index + 1, error }, "json2md: repairing a JSONL line");
            rows.push(SafeJSON.parse(jsonrepair(trimmed), { strict: true }));
        }
    });

    return rows;
}

/**
 * Reads and parses the input.
 *
 * `SafeJSON` is used rather than bare `JSON`, so a file with `//` comments or a trailing
 * comma still loads. `--repair` adds a `jsonrepair` pass, which is off by default because a
 * silent repair turns a typo into wrong output instead of an error.
 */
export async function readInput(options: ReadInputOptions): Promise<ReadInputResult> {
    const { text, source } = await readText(options.arg, options.isTTY);
    const detected = options.format === "auto" ? detectFormat(text, source) : options.format;

    logger.debug({ source, format: detected, bytes: text.length }, "json2md: input read");

    if (detected === "jsonl") {
        return { value: parseJsonl(text, options.repair ?? false), source, detected };
    }

    if (detected === "toml") {
        return { value: TOML.parse(text), source, detected };
    }

    try {
        return { value: SafeJSON.parse(text), source, detected };
    } catch (error) {
        if (!options.repair) {
            const hint = suggestCommand("tools json2md", { add: ["--repair"] });

            throw new Error(
                `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}\nTry again with --repair to run jsonrepair over it first.\n${hint}`
            );
        }

        logger.warn({ source }, "json2md: input needed jsonrepair");

        return { value: SafeJSON.parse(jsonrepair(text)), source, detected };
    }
}
