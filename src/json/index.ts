import minimist from "minimist";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import logger from "../logger";
import { encode, decode } from "@toon-format/toon";

interface Options {
    "to-toon"?: boolean;
    "to-json"?: boolean;
    verbose?: boolean;
    help?: boolean;
    // Aliases
    t?: boolean;
    j?: boolean;
    v?: boolean;
    h?: boolean;
}

interface Args extends Options {
    _: string[]; // Positional arguments
}

type Format = "json" | "toon" | "unknown";

function showHelp(): void {
    logger.info(`
JSON/TOON Converter Tool

Convert data between JSON and TOON (Token-Oriented Object Notation) formats.
TOON can reduce token usage by 30-60% compared to standard JSON, making it ideal for LLM applications.

Usage:
  tools json [file] [options]
  cat file.json | tools json [options]

Arguments:
  file                    Input file path (optional if reading from stdin)

Options:
  --to-toon, -t          Force conversion to TOON format
  --to-json, -j          Force conversion to JSON format
  --verbose, -v          Enable verbose logging (shows format detection, size comparison, etc.)
  --help, -h             Show this help message

Examples:
  # Auto-detect format and convert
  tools json data.json
  cat data.json | tools json

  # Force conversion to TOON
  tools json data.json --to-toon
  cat data.json | tools json --to-toon

  # Force conversion to JSON
  tools json data.toon --to-json
  cat data.toon | tools json --to-json

  # Verbose mode (shows statistics)
  tools json data.json --verbose

Notes:
  - If no file is provided, reads from stdin
  - Auto-detects input format (JSON or TOON) unless --to-toon or --to-json is specified
  - When converting to TOON, compares with compact JSON and returns the smaller format
  - By default, only outputs the result (or error). Use --verbose for detailed information.
`);
}

function detectFormat(input: string): Format {
    // Try JSON first
    try {
        JSON.parse(input);
        return "json";
    } catch {
        // Not JSON, try TOON
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

    // Read from stdin
    const reader = Bun.stdin.stream().getReader();
    let input = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            input += Buffer.from(value).toString();
        }
    } finally {
        reader.releaseLock();
    }

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

async function main(): Promise<void> {
    const argv = minimist<Args>(process.argv.slice(2), {
        alias: {
            t: "to-toon",
            j: "to-json",
            v: "verbose",
            h: "help",
        },
        boolean: ["to-toon", "to-json", "verbose", "help"],
    });

    if (argv.help) {
        showHelp();
        process.exit(0);
    }

    const forceToToon = argv["to-toon"] || false;
    const forceToJson = argv["to-json"] || false;
    const verbose = argv.verbose || false;

    // Validate flags
    if (forceToToon && forceToJson) {
        console.error("Error: Cannot specify both --to-toon and --to-json. Choose one.");
        process.exit(1);
    }

    try {
        // Get input file path (first positional argument)
        const inputPath = argv._[0];
        const input = await readInput(inputPath);

        if (!input) {
            console.error("Error: No input provided. Provide a file path or pipe data via stdin.");
            process.exit(1);
        }

        // Detect format
        const detectedFormat = detectFormat(input);

        if (detectedFormat === "unknown") {
            console.error("Error: Input is neither valid JSON nor TOON format. Please check your input and try again.");
            process.exit(1);
        }

        // Handle forced conversion
        if (forceToToon) {
            if (detectedFormat === "toon") {
                console.error(
                    "Error: Input is already in TOON format. Use --to-json to convert to JSON, or omit flags for auto-detection."
                );
                process.exit(1);
            }
            // Convert JSON to TOON
            try {
                const jsonData = JSON.parse(input);
                const toonOutput = encode(jsonData);
                const compactJson = JSON.stringify(jsonData);
                const toonSize = calculateSize(toonOutput);
                const jsonSize = calculateSize(compactJson);

                if (verbose) {
                    console.error(`Input format: JSON`);
                    console.error(`Output format: TOON`);
                    console.error(`Compact JSON size: ${jsonSize} bytes`);
                    console.error(`TOON size: ${toonSize} bytes`);

                    if (toonSize < jsonSize) {
                        const savings = calculateSavings(jsonSize, toonSize);
                        console.error(
                            `✓ TOON is ${savings.percentage.toFixed(1)}% smaller (${savings.bytes} bytes saved)`
                        );
                    } else {
                        const savings = calculateSavings(toonSize, jsonSize);
                        console.error(
                            `⚠ Compact JSON is ${savings.percentage.toFixed(1)}% smaller (${savings.bytes} bytes saved)`
                        );
                        console.error(`Returning TOON format as requested by --to-toon flag`);
                    }
                }

                // Return TOON (as requested) but log comparison
                console.log(toonOutput);
            } catch (error: any) {
                console.error(`Error converting to TOON: ${error.message}`);
                process.exit(1);
            }
        } else if (forceToJson) {
            if (detectedFormat === "json") {
                console.error(
                    "Error: Input is already in JSON format. Use --to-toon to convert to TOON, or omit flags for auto-detection."
                );
                process.exit(1);
            }
            // Convert TOON to JSON
            try {
                const jsonData = decode(input);
                const jsonOutput = JSON.stringify(jsonData, null, 2);

                if (verbose) {
                    console.error(`Input format: TOON`);
                    console.error(`Output format: JSON`);
                }

                console.log(jsonOutput);
            } catch (error: any) {
                console.error(`Error converting to JSON: ${error.message}`);
                process.exit(1);
            }
        } else {
            // Auto-detect and convert
            if (detectedFormat === "json") {
                // Convert JSON to TOON and compare with compact JSON
                try {
                    const jsonData = JSON.parse(input);
                    const toonOutput = encode(jsonData);
                    const compactJson = JSON.stringify(jsonData);
                    const toonSize = calculateSize(toonOutput);
                    const jsonSize = calculateSize(compactJson);

                    if (verbose) {
                        console.error(`Detected format: JSON`);
                        console.error(`Compact JSON size: ${jsonSize} bytes`);
                        console.error(`TOON size: ${toonSize} bytes`);
                    }

                    // Return the smaller format
                    if (toonSize < jsonSize) {
                        if (verbose) {
                            const savings = calculateSavings(jsonSize, toonSize);
                            console.error(
                                `✓ TOON is ${savings.percentage.toFixed(1)}% smaller (${savings.bytes} bytes saved)`
                            );
                            console.error(`Returning TOON format`);
                        }
                        console.log(toonOutput);
                    } else {
                        if (verbose) {
                            const savings = calculateSavings(toonSize, jsonSize);
                            console.error(
                                `⚠ Compact JSON is ${savings.percentage.toFixed(1)}% smaller (${
                                    savings.bytes
                                } bytes saved)`
                            );
                            console.error(`Returning compact JSON format`);
                        }
                        console.log(compactJson);
                    }
                } catch (error: any) {
                    console.error(`Error processing JSON: ${error.message}`);
                    process.exit(1);
                }
            } else {
                // Convert TOON to JSON
                try {
                    const jsonData = decode(input);
                    const jsonOutput = JSON.stringify(jsonData, null, 2);

                    if (verbose) {
                        console.error(`Detected format: TOON`);
                        console.error(`Output format: JSON`);
                    }

                    console.log(jsonOutput);
                } catch (error: any) {
                    console.error(`Error processing TOON: ${error.message}`);
                    process.exit(1);
                }
            }
        }
    } catch (error: any) {
        console.error(`Error: ${error.message}`);
        if (verbose) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(`Unexpected error: ${error}`);
    process.exit(1);
});
