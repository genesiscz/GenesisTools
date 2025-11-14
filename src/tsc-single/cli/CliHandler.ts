import minimist from "minimist";
import type { CliArgs, CommandType, TSServer } from "../core/interfaces.js";
import { LspServer } from "../providers/LspServer.js";
import { TscServer } from "../providers/TscServer.js";

/**
 * Handles CLI argument parsing and mode routing
 */
export class CliHandler {
    /**
     * Parse command line arguments
     */
    parseArgs(): CliArgs {
        return minimist<CliArgs>(process.argv.slice(2), {
            boolean: ["mcp", "diagnostics", "hover", "use-tsc", "warnings", "raw", "kill-server", "all", "help"],
            string: ["line", "char", "text", "root"],
            alias: {
                h: "help",
                d: "diagnostics",
                w: "warnings",
                l: "line",
                c: "char",
                t: "text",
                r: "root",
                k: "kill-server",
            },
            default: {
                "use-tsc": false,
                warnings: false,
                raw: false,
                "kill-server": false,
                all: false,
            },
        });
    }

    /**
     * Determine which command to run based on arguments
     */
    determineCommand(argv: CliArgs): CommandType {
        if (argv["kill-server"]) return "kill-server" as CommandType;
        if (argv.mcp) return "mcp" as CommandType;
        if (argv.hover) return "hover" as CommandType;
        if (argv.diagnostics) return "diagnostics" as CommandType;

        // Default to diagnostics for backward compatibility
        return "diagnostics" as CommandType;
    }

    /**
     * Create appropriate TSServer instance based on flags
     */
    createTsServer(argv: CliArgs, cwd: string): TSServer {
        if (argv["use-tsc"]) {
            return new TscServer({ cwd });
        } else {
            // LSP is the default
            return new LspServer({ cwd, debug: process.env.DEBUG === "1" });
        }
    }

    /**
     * Show help message
     */
    showHelp(): void {
        console.error("Usage: tsc-single [options] <file|directory|pattern> [...more]");
        console.error("");
        console.error("Commands:");
        console.error("  -d, --diagnostics    Check TypeScript files for errors (default)");
        console.error("  --hover              Get hover information at a specific location");
        console.error("  --mcp                Run as MCP server");
        console.error("  -k, --kill-server    Kill persistent LSP server(s)");
        console.error("");
        console.error("Options:");
        console.error("  --use-tsc            Use TypeScript Compiler API instead of LSP");
        console.error("  -w, --warnings       Show warnings in addition to errors");
        console.error("  -r, --root <path>    Override working directory (default: current directory)");
        console.error("");
        console.error("Hover Command Options:");
        console.error("  -l, --line <num>     Line number (required with --hover)");
        console.error("  -c, --char <num>     Character position (optional)");
        console.error("  -t, --text <string>  Text to search for on line (optional)");
        console.error("  --raw                Show full JSON with raw LSP data");
        console.error("");
        console.error("Examples:");
        console.error("  # Diagnostics");
        console.error("  tsc-single src/app.ts                            # single file (default command)");
        console.error("  tsc-single -d src                                # all TS files in src/");
        console.error("  tsc-single --diagnostics 'src/**/*.ts'           # glob pattern");
        console.error("  tsc-single -d -w src/app.ts                      # show warnings");
        console.error("  tsc-single --use-tsc src/app.ts                  # use compiler API");
        console.error("");
        console.error("  # Hover / Type Introspection");
        console.error("  tsc-single --hover -l 10 src/app.ts              # hover at line 10");
        console.error("  tsc-single --hover -l 10 -t myVar src/app.ts     # hover on 'myVar'");
        console.error("  tsc-single --hover -l 10 --raw src/app.ts        # include raw LSP data");
        console.error("");
        console.error("  # Server Management");
        console.error("  tsc-single --kill-server                         # kill server for current dir");
        console.error("  tsc-single -k --all                              # kill all servers");
        console.error("  tsc-single --mcp /path/to/project                # run as MCP server");
        console.error("");
        console.error("Note: LSP servers are persistent and reused across runs for better performance.");
    }
}
