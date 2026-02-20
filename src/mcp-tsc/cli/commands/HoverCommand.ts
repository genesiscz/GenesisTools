import path from "node:path";
import type { CliArgs, HoverResult, TSServer } from "@app/mcp-tsc/core/interfaces.js";
import ts from "typescript";

export class HoverCommand {
    constructor(
        private tsServer: TSServer,
        private cwd: string
    ) {}

    async execute(argv: CliArgs): Promise<void> {
        // Validate hover-specific requirements
        if (!argv.line) {
            console.error("Error: --line is required with --hover");
            process.exit(1);
        }

        if (argv._.length !== 1) {
            console.error("Error: --hover requires exactly one file");
            process.exit(1);
        }

        const filePath = argv._[0];
        const absolutePath = path.resolve(this.cwd, filePath);

        if (!ts.sys.fileExists(absolutePath)) {
            console.error(`Error: File not found: ${filePath}`);
            process.exit(1);
        }

        const lineNumber = parseInt(argv.line, 10);
        if (Number.isNaN(lineNumber) || lineNumber < 1) {
            console.error(`Error: Invalid line number: ${argv.line}`);
            process.exit(1);
        }

        // Read file to get line content
        const fileContent = ts.sys.readFile(absolutePath);
        if (!fileContent) {
            console.error(`Error: Could not read file: ${filePath}`);
            process.exit(1);
        }

        const lines = fileContent.split("\n");
        if (lineNumber > lines.length) {
            console.error(`Error: Line ${lineNumber} is out of range (file has ${lines.length} lines)`);
            process.exit(1);
        }

        const lineContent = lines[lineNumber - 1];
        let character: number;

        // Smart position handling
        if (argv.text) {
            const index = lineContent.indexOf(argv.text);
            if (index === -1) {
                console.error(`Error: Text "${argv.text}" not found on line ${lineNumber}`);
                process.exit(1);
            }
            character = index + 1;
        } else if (argv.char) {
            character = parseInt(argv.char, 10);
            if (Number.isNaN(character) || character < 1) {
                console.error(`Error: Invalid character position: ${argv.char}`);
                process.exit(1);
            }
        } else {
            // Find first non-whitespace character
            const match = lineContent.match(/\S/);
            character = match ? match.index! + 1 : 1;
        }

        // Initialize server if needed
        if (this.tsServer.initialize) {
            await this.tsServer.initialize();
        }

        // Get hover information
        try {
            const hover = await this.tsServer.getHover(absolutePath, { line: lineNumber, character });

            // Display result
            if (argv.raw) {
                interface CLIHoverOutput {
                    file: string;
                    line: number;
                    character: number;
                    lineContent: string;
                    hover: string;
                    raw?: HoverResult["raw"];
                }

                const output: CLIHoverOutput = {
                    file: filePath,
                    line: lineNumber,
                    character: character,
                    lineContent: lineContent,
                    hover: hover.contents,
                };
                if (hover.raw) {
                    output.raw = hover.raw;
                }
                console.log(JSON.stringify(output, null, 2));
            } else {
                console.log(`File: ${filePath}`);
                console.log(`Line: ${lineNumber}`);
                console.log(`Character: ${character}`);
                console.log(`Content: ${lineContent}`);
                console.log();
                if (hover.contents) {
                    console.log("Hover Information:");
                    console.log(hover.contents);
                } else {
                    console.log("No hover information available at this location");
                }
            }
        } catch (error) {
            console.error(`Error getting hover information: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
    }
}
