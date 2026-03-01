import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handleReadmeFlag } from "@app/utils/readme";
import { decode, encode } from "@toon-format/toon";
import { Command } from "commander";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

type Format = "json" | "jsonl" | "toon" | "embedded-json" | "unknown";

function parseJSONL(input: string): unknown[] | null {
    const trimmed = input.trim();
    if (!trimmed) {
        return null;
    }

    // First, try parsing as a single JSON object/array
    try {
        JSON.parse(trimmed);
        return null; // It's regular JSON, not JSONL
    } catch {
        // Not a single JSON, try JSONL
    }

    // Try to parse as JSONL - multiple JSON objects separated by newlines
    // Handle both single-line and multi-line JSON objects
    const objects: unknown[] = [];
    let currentObject = "";
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < trimmed.length; i++) {
        const char = trimmed[i];
        currentObject += char;

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === "\\") {
            escapeNext = true;
            continue;
        }

        if (char === '"') {
            inString = !inString;
            continue;
        }

        if (inString) {
            continue;
        }

        if (char === "{" || char === "[" || char === "(") {
            depth++;
        } else if (char === "}" || char === "]" || char === ")") {
            depth--;
            if (depth === 0) {
                // Found a complete JSON object
                try {
                    const parsed = JSON.parse(currentObject.trim());
                    objects.push(parsed);
                    currentObject = "";
                    // Skip whitespace and newlines before next object
                    while (i + 1 < trimmed.length && /\s/.test(trimmed[i + 1])) {
                        i++;
                    }
                } catch {
                    // Not valid JSON, continue accumulating
                }
            }
        }
    }

    // If we found at least one object, it's JSONL
    return objects.length > 0 ? objects : null;
}

/**
 * Try to extract a JSON object/array from mixed text input (e.g. "Error 400: {...}").
 * Returns the extracted JSON string or null if none found.
 */
function extractEmbeddedJson(input: string): string | null {
    // Find the first { or [ that could start a JSON value
    for (const startChar of ["{", "["]) {
        const startIdx = input.indexOf(startChar);

        if (startIdx < 0) {
            continue;
        }

        const endChar = startChar === "{" ? "}" : "]";
        // Find the matching closing bracket from the end
        const endIdx = input.lastIndexOf(endChar);

        if (endIdx <= startIdx) {
            continue;
        }

        const candidate = input.slice(startIdx, endIdx + 1);

        try {
            JSON.parse(candidate);
            return candidate;
        } catch {
            // Not valid JSON, try next
        }
    }

    return null;
}

function detectFormat(input: string): Format {
    // Try JSON first
    try {
        JSON.parse(input);
        return "json";
    } catch {
        // Try JSONL (newline-delimited JSON)
        const jsonlData = parseJSONL(input);
        if (jsonlData && jsonlData.length > 0) {
            return "jsonl";
        }
        // Try extracting embedded JSON from mixed text
        // (before TOON, since TOON's colon syntax produces false positives
        // on text like "API 400: {"success": false}")
        if (extractEmbeddedJson(input)) {
            return "embedded-json";
        }

        // Not JSON or JSONL or embedded JSON, try TOON
        try {
            decode(input);
            return "toon";
        } catch {
            return "unknown";
        }
    }
}

async function readInput(filePath?: string): Promise<string> {
    if (filePath) {
        const resolvedPath = resolve(filePath);
        if (!existsSync(resolvedPath)) {
            console.error(`Error: File not found: ${resolvedPath}`);
            process.exit(1);
        }
        return readFileSync(resolvedPath, "utf-8").trim();
    }

    // Read from stdin - use Bun.stdin.text() which properly waits for all data
    const input = await Bun.stdin.text();
    return input.trim();
}

function calculateSize(str: string): number {
    return Buffer.byteLength(str, "utf8");
}

function calculateSavings(original: number, compressed: number): { percentage: number; bytes: number } {
    const bytes = original - compressed;
    const percentage = original > 0 ? (bytes / original) * 100 : 0;
    return { percentage, bytes };
}

/**
 * Compare TOON vs compact JSON sizes, log to stderr if verbose, return the winner.
 */
function logSizeComparison(toonOutput: string, jsonData: unknown, verbose: boolean): "toon" | "json" {
    const compactJson = JSON.stringify(jsonData);
    const toonSize = calculateSize(toonOutput);
    const jsonSize = calculateSize(compactJson);
    const toonWins = toonSize < jsonSize;

    if (verbose) {
        console.error(`Compact JSON size: ${jsonSize} bytes`);
        console.error(`TOON size: ${toonSize} bytes`);

        if (toonWins) {
            const savings = calculateSavings(jsonSize, toonSize);
            console.error(`✓ TOON is ${savings.percentage.toFixed(1)}% smaller (${savings.bytes} bytes saved)`);
        } else {
            const savings = calculateSavings(toonSize, jsonSize);
            console.error(`⚠ Compact JSON is ${savings.percentage.toFixed(1)}% smaller (${savings.bytes} bytes saved)`);
        }
    }

    return toonWins ? "toon" : "json";
}

/**
 * Convert JSON data to the smallest format (TOON or compact JSON) and output it.
 */
function outputSmallestFormat(jsonData: unknown, verbose: boolean): void {
    const toonOutput = encode(jsonData);
    const winner = logSizeComparison(toonOutput, jsonData, verbose);

    if (winner === "toon") {
        if (verbose) {
            console.error(`Returning TOON format`);
        }

        console.log(toonOutput);
    } else {
        if (verbose) {
            console.error(`Returning compact JSON format`);
        }

        console.log(JSON.stringify(jsonData));
    }
}

/**
 * Decode TOON input and return pretty-printed JSON.
 */
function toonToJson(input: string): string {
    const decoded = decode(input);
    return JSON.stringify(decoded, null, 2);
}

async function main(): Promise<void> {
    const program = new Command()
        .name("json")
        .description(
            "JSON/TOON converter - Convert data between JSON and TOON (Token-Oriented Object Notation) formats"
        )
        .argument("[file]", "Input file path (optional if reading from stdin)")
        .option("-t, --to-toon", "Force conversion to TOON format")
        .option("-j, --to-json", "Force conversion to JSON format")
        .option("-v, --verbose", "Enable verbose logging (shows format detection, size comparison, etc.)")
        .option("--validate", "Error on invalid JSON/TOON input (default: passthrough)")
        .parse();

    const options = program.opts();
    const args = program.args;

    const forceToToon = options.toToon || false;
    const forceToJson = options.toJson || false;
    const verbose = options.verbose || false;
    const validate = options.validate || false;

    // Validate flags
    if (forceToToon && forceToJson) {
        console.error("Error: Cannot specify both --to-toon and --to-json. Choose one.");
        process.exit(1);
    }

    try {
        // Get input file path (first positional argument)
        const inputPath = args[0];
        const input = await readInput(inputPath);

        if (!input) {
            console.error("Error: No input provided. Provide a file path or pipe data via stdin.");
            process.exit(1);
        }

        // Detect format
        const detectedFormat = detectFormat(input);

        if (detectedFormat === "unknown") {
            if (validate) {
                console.error(
                    "Error: Input is neither valid JSON, JSONL, nor TOON format. Please check your input and try again."
                );
                process.exit(1);
            }
            // Passthrough: output original input unchanged
            console.log(input);
            return;
        }

        // Normalize JSONL to JSON array for processing
        let jsonData: unknown;

        if (detectedFormat === "jsonl") {
            const jsonlData = parseJSONL(input);

            if (!jsonlData) {
                console.error("Error: Failed to parse JSONL input.");
                process.exit(1);
            }

            jsonData = jsonlData;
        } else if (detectedFormat === "embedded-json") {
            const extracted = extractEmbeddedJson(input);
            jsonData = JSON.parse(extracted!);
        } else if (detectedFormat === "json") {
            jsonData = JSON.parse(input);
        }

        const formatLabel =
            detectedFormat === "jsonl"
                ? "JSONL"
                : detectedFormat === "toon"
                  ? "TOON"
                  : detectedFormat === "embedded-json"
                    ? "Embedded JSON"
                    : "JSON";

        // Handle forced conversion to TOON
        if (forceToToon) {
            if (detectedFormat === "toon") {
                console.error(
                    "Error: Input is already in TOON format. Use --to-json to convert to JSON, or omit flags for auto-detection."
                );
                process.exit(1);
            }

            const toonOutput = encode(jsonData);

            if (verbose) {
                console.error(`Input format: ${formatLabel}`);
                console.error(`Output format: TOON`);
            }

            const winner = logSizeComparison(toonOutput, jsonData, verbose);

            if (verbose && winner === "json") {
                console.error(`Returning TOON format as requested by --to-toon flag`);
            }

            console.log(toonOutput);
            return;
        }

        // Handle forced conversion to JSON
        if (forceToJson) {
            if (verbose) {
                console.error(`Input format: ${formatLabel}`);
                console.error(`Output format: JSON`);
            }

            if (detectedFormat === "toon") {
                console.log(toonToJson(input));
            } else {
                console.log(JSON.stringify(jsonData, null, 2));
            }

            return;
        }

        // Auto-detect: TOON input → JSON, JSON/JSONL input → smallest format
        if (detectedFormat === "toon") {
            if (verbose) {
                console.error(`Detected format: TOON`);
                console.error(`Output format: JSON`);
            }

            console.log(toonToJson(input));
        } else {
            if (verbose) {
                console.error(`Detected format: ${formatLabel}`);
            }

            outputSmallestFormat(jsonData, verbose);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);

        if (verbose && error instanceof Error) {
            console.error(error.stack);
        }

        process.exit(1);
    }
}

main().catch((error) => {
    console.error(`Unexpected error: ${error}`);
    process.exit(1);
});
