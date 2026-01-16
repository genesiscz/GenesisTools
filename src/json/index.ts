import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { encode, decode } from "@toon-format/toon";

type Format = "json" | "jsonl" | "toon" | "unknown";

function parseJSONL(input: string): any[] | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    // First, try parsing as a single JSON object/array
    try {
        JSON.parse(trimmed);
        return null; // It's regular JSON, not JSONL
    } catch {
        // Not a single JSON, try JSONL
    }

    // Try to parse as JSONL - multiple JSON objects separated by newlines
    // Handle both single-line and multi-line JSON objects
    const objects: any[] = [];
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

        if (inString) continue;

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
        // Not JSON or JSONL, try TOON
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

async function main(): Promise<void> {
    const program = new Command()
        .name("json")
        .description("JSON/TOON converter - Convert data between JSON and TOON (Token-Oriented Object Notation) formats")
        .argument("[file]", "Input file path (optional if reading from stdin)")
        .option("-t, --to-toon", "Force conversion to TOON format")
        .option("-j, --to-json", "Force conversion to JSON format")
        .option("-v, --verbose", "Enable verbose logging (shows format detection, size comparison, etc.)")
        .parse();

    const options = program.opts();
    const args = program.args;

    const forceToToon = options.toToon || false;
    const forceToJson = options.toJson || false;
    const verbose = options.verbose || false;

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
            console.error(
                "Error: Input is neither valid JSON, JSONL, nor TOON format. Please check your input and try again."
            );
            process.exit(1);
        }

        // Normalize JSONL to JSON array for processing
        let jsonData: any;
        if (detectedFormat === "jsonl") {
            const jsonlData = parseJSONL(input);
            if (!jsonlData) {
                console.error("Error: Failed to parse JSONL input.");
                process.exit(1);
            }
            jsonData = jsonlData;
        } else if (detectedFormat === "json") {
            jsonData = JSON.parse(input);
        }

        // Handle forced conversion
        if (forceToToon) {
            if (detectedFormat === "toon") {
                console.error(
                    "Error: Input is already in TOON format. Use --to-json to convert to JSON, or omit flags for auto-detection."
                );
                process.exit(1);
            }
            // Convert JSON/JSONL to TOON
            try {
                const toonOutput = encode(jsonData);
                const compactJson = JSON.stringify(jsonData);
                const toonSize = calculateSize(toonOutput);
                const jsonSize = calculateSize(compactJson);

                if (verbose) {
                    console.error(`Input format: ${detectedFormat === "jsonl" ? "JSONL" : "JSON"}`);
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
            if (detectedFormat === "json" || detectedFormat === "jsonl") {
                // Convert JSON/JSONL to formatted JSON array
                try {
                    const jsonOutput = JSON.stringify(jsonData, null, 2);

                    if (verbose) {
                        console.error(`Input format: ${detectedFormat === "jsonl" ? "JSONL" : "JSON"}`);
                        console.error(`Output format: JSON`);
                    }

                    console.log(jsonOutput);
                } catch (error: any) {
                    console.error(`Error converting to JSON: ${error.message}`);
                    process.exit(1);
                }
            } else {
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
            }
        } else {
            // Auto-detect and convert
            if (detectedFormat === "json" || detectedFormat === "jsonl") {
                // Convert JSON/JSONL to TOON and compare with compact JSON
                try {
                    const toonOutput = encode(jsonData);
                    const compactJson = JSON.stringify(jsonData);
                    const toonSize = calculateSize(toonOutput);
                    const jsonSize = calculateSize(compactJson);

                    if (verbose) {
                        console.error(`Detected format: ${detectedFormat === "jsonl" ? "JSONL" : "JSON"}`);
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
