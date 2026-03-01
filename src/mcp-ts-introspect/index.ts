import chalk from "chalk";
import clipboardy from "clipboardy";
import Enquirer from "enquirer";
import minimist from "minimist";
import logger from "../logger";
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
    help?: boolean;
    mcp?: boolean;
    // Aliases
    m?: string;
    p?: string;
    s?: string;
    t?: string;
    o?: string;
    v?: boolean;
    h?: boolean;
}

interface Args extends Options {
    _: string[]; // Positional arguments
}

const prompter = new Enquirer();

function showHelp() {
    console.log(`
Usage: tools mcp-ts-introspect [options]

Introspect TypeScript exports from packages, source code, or projects.

Modes:
  -m, --mode MODE         Introspection mode: package, source, or project
  -p, --package NAME      Package name to introspect (for package mode)
  -s, --source CODE       TypeScript source code to analyze (for source mode)
  --project PATH          Project path to analyze (for project mode, defaults to current directory)

Options:
  --search-paths PATH     Additional paths to search for packages (can use multiple times)
  -t, --search-term TERM  Filter exports by search term (supports regex)
  --cache                 Enable caching (default: true)
  --cache-dir DIR         Cache directory (default: .ts-morph-cache)
  --limit NUM             Maximum number of results to return
  -o, --output DEST       Output destination: file, clipboard, or stdout (default: stdout)
  -v, --verbose           Enable verbose logging
  -h, --help              Show this help message
  --mcp                   Run as MCP server

Examples:
  tools mcp-ts-introspect -m package -p typescript -t "Type.*" -o clipboard
  tools mcp-ts-introspect -m source -s "export function hello() { return 'world'; }"
  tools mcp-ts-introspect -m project --search-term "^get" --limit 20
  tools mcp-ts-introspect  # Interactive mode
  tools mcp-ts-introspect --mcp  # Run as MCP server
`);
}

async function getMode(argv: Args): Promise<string> {
    if (argv.mode) {
        return argv.mode;
    }

    // Try to infer mode from other arguments
    if (argv.package) {
        return "package";
    }
    if (argv.source) {
        return "source";
    }
    if (argv.project !== undefined) {
        return "project";
    }

    // Interactive prompt
    try {
        const response = (await prompter.prompt({
            type: "select",
            name: "mode",
            message: "Select introspection mode:",
            choices: ["package", "source", "project"],
        })) as { mode: string };

        return response.mode;
    } catch (error: unknown) {
        if (error instanceof Error && error.message === "canceled") {
            logger.info("\nOperation cancelled by user.");
            process.exit(0);
        }
        throw error;
    }
}

async function getPackageName(argv: Args): Promise<string> {
    if (argv.package) {
        return argv.package;
    }

    try {
        const response = (await prompter.prompt({
            type: "input",
            name: "packageName",
            message: "Enter package name to introspect:",
            initial: "typescript",
        })) as { packageName: string };

        return response.packageName;
    } catch (error: unknown) {
        if (error instanceof Error && error.message === "canceled") {
            logger.info("\nOperation cancelled by user.");
            process.exit(0);
        }
        throw error;
    }
}

async function getSourceCode(argv: Args): Promise<string> {
    if (argv.source) {
        return argv.source;
    }

    try {
        const response = (await prompter.prompt({
            type: "input",
            name: "source",
            message: "Enter TypeScript source code:",
            multiline: true,
            initial: "export function example() { return 42; }",
        })) as { source: string };

        return response.source;
    } catch (error: unknown) {
        if (error instanceof Error && error.message === "canceled") {
            logger.info("\nOperation cancelled by user.");
            process.exit(0);
        }
        throw error;
    }
}

async function getProjectPath(argv: Args): Promise<string> {
    if (typeof argv.project === "string") {
        return argv.project;
    }

    try {
        const response = (await prompter.prompt({
            type: "input",
            name: "projectPath",
            message: "Enter project path:",
            initial: process.cwd(),
        })) as { projectPath: string };

        return response.projectPath;
    } catch (error: unknown) {
        if (error instanceof Error && error.message === "canceled") {
            logger.info("\nOperation cancelled by user.");
            process.exit(0);
        }
        throw error;
    }
}

async function getOutputDestination(argv: Args): Promise<string> {
    if (argv.output) {
        return argv.output;
    }

    try {
        const response = (await prompter.prompt({
            type: "select",
            name: "output",
            message: "Where to output results?",
            choices: ["stdout", "clipboard", "file"],
        })) as { output: string };

        if (response.output === "file") {
            const fileResponse = (await prompter.prompt({
                type: "input",
                name: "filename",
                message: "Enter output filename:",
                initial: "exports.json",
            })) as { filename: string };

            return fileResponse.filename;
        }

        return response.output;
    } catch (error: unknown) {
        if (error instanceof Error && error.message === "canceled") {
            logger.info("\nOperation cancelled by user.");
            process.exit(0);
        }
        throw error;
    }
}

function formatExports(exports: ExportInfo[], verbose: boolean): string {
    if (exports.length === 0) {
        return "No exports found.";
    }

    const output: string[] = [];

    if (verbose) {
        // Detailed JSON format
        return JSON.stringify(exports, null, 2);
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

async function main() {
    const argv = minimist<Args>(process.argv.slice(2), {
        alias: {
            m: "mode",
            p: "package",
            s: "source",
            t: "searchTerm",
            o: "output",
            v: "verbose",
            h: "help",
        },
        boolean: ["cache", "verbose", "help", "mcp"],
        string: ["mode", "package", "source", "project", "searchTerm", "cacheDir", "output"],
        default: {
            cache: true,
            cacheDir: ".ts-morph-cache",
        },
    });

    if (argv.help) {
        showHelp();
        process.exit(0);
    }

    // Run as MCP server if --mcp flag is set
    if (argv.mcp) {
        await startMcpServer();
        return; // The server runs indefinitely
    }

    try {
        // Get introspection mode
        const mode = await getMode(argv);

        // Build options
        const options: IntrospectOptions = {
            searchPaths: Array.isArray(argv.searchPaths)
                ? argv.searchPaths
                : argv.searchPaths
                  ? [argv.searchPaths]
                  : [],
            searchTerm: argv.searchTerm,
            cache: argv.cache,
            cacheDir: argv.cacheDir,
            limit: argv.limit,
        };

        if (argv.verbose) {
            logger.info(`Introspection mode: ${mode}`);
            logger.info(`Options: ${JSON.stringify(options, null, 2)}`);
        }

        let exports: ExportInfo[] = [];

        // Execute introspection based on mode
        switch (mode) {
            case "package": {
                const packageName = await getPackageName(argv);
                if (argv.verbose) {
                    logger.info(`Introspecting package: ${packageName}`);
                }
                exports = await introspectPackage(packageName, options);
                break;
            }

            case "source": {
                const sourceCode = await getSourceCode(argv);
                if (argv.verbose) {
                    logger.info(`Introspecting source code...`);
                }
                exports = await introspectSource(sourceCode, options);
                break;
            }

            case "project": {
                const projectPath = await getProjectPath(argv);
                if (argv.verbose) {
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
        const formattedOutput = formatExports(exports, argv.verbose || false);

        // Handle output
        const outputDest = await getOutputDestination(argv);

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
        if (argv.verbose && error instanceof Error) {
            console.error(error.stack || "");
        }
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(`\n✖ Unexpected error: ${err}`);
    process.exit(1);
});
