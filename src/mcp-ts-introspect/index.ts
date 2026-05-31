import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { ExitPromptError } from "@inquirer/core";
import { editor, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import clipboardy from "clipboardy";
import { Command } from "commander";
import { introspectPackage, introspectProject, introspectSource } from "./introspect";
import { startMcpServer } from "./mcp-server";
import type { ExportInfo, IntrospectOptions } from "./types";

interface Options {
    mode?: string;
    package?: string;
    source?: string;
    project?: string;
    searchPaths?: string[];
    searchTerm?: string;
    cache?: boolean;
    cacheDir?: string;
    limit?: number;
    output?: string;
    verbose?: boolean;
    mcp?: boolean;
}

function cancelOnExit(error: unknown): never {
    if (error instanceof ExitPromptError) {
        logger.info("\nOperation cancelled by user.");
        process.exit(0);
    }
    throw error;
}

async function getMode(opts: Options): Promise<string> {
    if (opts.mode) {
        return opts.mode;
    }

    // Try to infer mode from other arguments
    if (opts.package) {
        return "package";
    }
    if (opts.source) {
        return "source";
    }
    if (opts.project !== undefined) {
        return "project";
    }

    // Interactive prompt
    try {
        return await select({
            message: "Select introspection mode:",
            choices: ["package", "source", "project"],
        });
    } catch (error: unknown) {
        cancelOnExit(error);
    }
}

async function getPackageName(opts: Options): Promise<string> {
    if (opts.package) {
        return opts.package;
    }

    try {
        return await input({
            message: "Enter package name to introspect:",
            default: "typescript",
        });
    } catch (error: unknown) {
        cancelOnExit(error);
    }
}

async function getSourceCode(opts: Options): Promise<string> {
    if (opts.source) {
        return opts.source;
    }

    try {
        return await editor({
            message: "Enter TypeScript source code:",
            default: "export function example() { return 42; }",
        });
    } catch (error: unknown) {
        cancelOnExit(error);
    }
}

async function getProjectPath(opts: Options): Promise<string> {
    if (typeof opts.project === "string") {
        return opts.project;
    }

    try {
        return await input({
            message: "Enter project path:",
            default: process.cwd(),
        });
    } catch (error: unknown) {
        cancelOnExit(error);
    }
}

async function getOutputDestination(opts: Options): Promise<string> {
    if (opts.output) {
        return opts.output;
    }

    try {
        const output = await select({
            message: "Where to output results?",
            choices: ["stdout", "clipboard", "file"],
        });

        if (output === "file") {
            return await input({
                message: "Enter output filename:",
                default: "exports.json",
            });
        }

        return output;
    } catch (error: unknown) {
        cancelOnExit(error);
    }
}

function formatExports(exports: ExportInfo[], verbose: boolean): string {
    if (exports.length === 0) {
        return "No exports found.";
    }

    const output: string[] = [];

    if (verbose) {
        // Detailed JSON format
        return SafeJSON.stringify(exports, null, 2);
    } else {
        // Concise human-readable format
        output.push(`Found ${exports.length} export(s):\n`);

        exports.forEach((exp, index) => {
            output.push(`${index + 1}. ${chalk.cyan(exp.name)} (${chalk.yellow(exp.kind)})`);
            output.push(`   ${chalk.gray(exp.typeSignature)}`);
            if (exp.description) {
                output.push(`   ${chalk.dim(exp.description)}`);
            }
            output.push("");
        });
    }

    return output.join("\n");
}

interface RawOptions {
    mode?: string;
    package?: string;
    source?: string;
    project?: string;
    searchPaths?: string[];
    searchTerm?: string;
    cache: boolean;
    cacheDir: string;
    limit?: string;
    output?: string;
    verbose?: boolean;
    mcp?: boolean;
}

function collect(value: string, previous: string[]): string[] {
    return previous.concat([value]);
}

async function run(opts: Options) {
    // Run as MCP server if --mcp flag is set
    if (opts.mcp) {
        await startMcpServer();
        return; // The server runs indefinitely
    }

    try {
        // Get introspection mode
        const mode = await getMode(opts);

        // Build options
        const options: IntrospectOptions = {
            searchPaths: opts.searchPaths ?? [],
            searchTerm: opts.searchTerm,
            cache: opts.cache,
            cacheDir: opts.cacheDir,
            limit: opts.limit,
        };

        if (opts.verbose) {
            logger.info(`Introspection mode: ${mode}`);
            logger.info(`Options: ${SafeJSON.stringify(options, null, 2)}`);
        }

        let exports: ExportInfo[] = [];

        // Execute introspection based on mode
        switch (mode) {
            case "package": {
                const packageName = await getPackageName(opts);
                if (opts.verbose) {
                    logger.info(`Introspecting package: ${packageName}`);
                }
                exports = await introspectPackage(packageName, options);
                break;
            }

            case "source": {
                const sourceCode = await getSourceCode(opts);
                if (opts.verbose) {
                    logger.info(`Introspecting source code...`);
                }
                exports = await introspectSource(sourceCode, options);
                break;
            }

            case "project": {
                const projectPath = await getProjectPath(opts);
                if (opts.verbose) {
                    logger.info(`Introspecting project: ${projectPath}`);
                }
                exports = await introspectProject(projectPath, options);
                break;
            }

            default:
                logger.error(`Invalid mode: ${mode}`);
                process.exit(1);
        }

        // Format results
        const formattedOutput = formatExports(exports, opts.verbose || false);

        // Handle output
        const outputDest = await getOutputDestination(opts);

        if (outputDest === "clipboard") {
            await clipboardy.write(formattedOutput);
            logger.info("✔ Results copied to clipboard!");
        } else if (outputDest === "stdout") {
            console.log(formattedOutput);
        } else {
            // Output to file
            await Bun.write(outputDest, formattedOutput);
            logger.info(`✔ Results written to ${outputDest}`);
        }
    } catch (error) {
        console.error(`✖ Error: ${error}`);
        if (opts.verbose && error instanceof Error) {
            console.error(error.stack || "");
        }
        process.exit(1);
    }
}

const program = new Command();

program
    .name("mcp-ts-introspect")
    .description("Introspect TypeScript exports from packages, source code, or projects.")
    .option("-m, --mode <mode>", "Introspection mode: package, source, or project")
    .option("-p, --package <name>", "Package name to introspect (for package mode)")
    .option("-s, --source <code>", "TypeScript source code to analyze (for source mode)")
    .option("--project <path>", "Project path to analyze (for project mode, defaults to current directory)")
    .option("--search-paths <path>", "Additional paths to search for packages (repeatable)", collect, [])
    .option("-t, --search-term <term>", "Filter exports by search term (supports regex)")
    .option("--no-cache", "Disable caching")
    .option("--cache-dir <dir>", "Cache directory", ".ts-morph-cache")
    .option("--limit <num>", "Maximum number of results to return")
    .option("-o, --output <dest>", "Output destination: file, clipboard, or stdout (default: stdout)")
    .option("-v, --verbose", "Enable verbose logging")
    .option("--mcp", "Run as MCP server")
    .addHelpText(
        "after",
        `
Examples:
  tools mcp-ts-introspect -m package -p typescript -t "Type.*" -o clipboard
  tools mcp-ts-introspect -m source -s "export function hello() { return 'world'; }"
  tools mcp-ts-introspect -m project --search-term "^get" --limit 20
  tools mcp-ts-introspect  # Interactive mode
  tools mcp-ts-introspect --mcp  # Run as MCP server
`
    )
    .action(async (raw: RawOptions) => {
        const opts: Options = {
            mode: raw.mode,
            package: raw.package,
            source: raw.source,
            project: raw.project,
            searchPaths: raw.searchPaths,
            searchTerm: raw.searchTerm,
            cache: raw.cache,
            cacheDir: raw.cacheDir,
            limit: raw.limit !== undefined ? Number(raw.limit) : undefined,
            output: raw.output,
            verbose: raw.verbose,
            mcp: raw.mcp,
        };
        await run(opts);
    });

program.parseAsync().catch((err) => {
    console.error(`\n✖ Unexpected error: ${err}`);
    process.exit(1);
});
