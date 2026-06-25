import { out } from "@app/logger";
import type { CliArgs, CommandType, TSServer } from "@app/mcp-tsc/core/interfaces.js";
import { LspServer } from "@app/mcp-tsc/providers/LspServer.js";
import { TscServer } from "@app/mcp-tsc/providers/TscServer.js";
import { env } from "@app/utils/env";
import { Command } from "commander";

/**
 * Handles CLI argument parsing and mode routing
 */
export class CliHandler {
    /**
     * Parse command line arguments
     */
    parseArgs(): CliArgs {
        const program = new Command()
            .name("mcp-tsc")
            .description("TypeScript diagnostics MCP server")
            .option("-d, --diagnostics", "Check TypeScript files for errors (default)")
            .option("-w, --warnings", "Show warnings in addition to errors")
            .option("-l, --line <num>", "Line number (required with --hover)")
            .option("-c, --char <num>", "Character position (optional)")
            .option("-t, --text <string>", "Text to search for on line (optional)")
            .option("-r, --root <path>", "Override working directory (default: current directory)")
            .option("--mcp", "Run as MCP server")
            .option("--hover", "Get hover information at a specific location")
            .option("--use-tsc", "Use TypeScript Compiler API instead of LSP")
            .option("--raw", "Show full JSON with raw LSP data")
            .option("-k, --kill-server", "Kill persistent LSP server(s)")
            .option("--all", "Kill all servers (use with --kill-server)")
            .option("--timeout <seconds>", "Timeout for diagnostics in seconds", "30")
            .option("-?, --help-full", "Show detailed help message")
            .argument("[files...]", "Files to analyze")
            .allowUnknownOption(false)
            .parse();

        const opts = program.opts();
        const args = program.args;

        // Handle --help-full to show our custom help
        if (opts.helpFull) {
            this.showHelp();
            process.exit(0);
        }

        // Convert timeout to number and validate
        let timeoutValue = opts.timeout ? Number(opts.timeout) : 30;
        if (!Number.isFinite(timeoutValue) || timeoutValue <= 0) {
            out.error(`Invalid timeout: ${opts.timeout}. Using default of 30 seconds.`);
            timeoutValue = 30;
        }

        return {
            _: args,
            mcp: opts.mcp ?? false,
            diagnostics: opts.diagnostics ?? false,
            hover: opts.hover ?? false,
            "use-tsc": opts.useTsc ?? false,
            warnings: opts.warnings ?? false,
            raw: opts.raw ?? false,
            line: opts.line,
            char: opts.char,
            text: opts.text,
            root: opts.root,
            "kill-server": opts.killServer ?? false,
            all: opts.all ?? false,
            help: false, // Commander handles --help automatically
            timeout: timeoutValue,
        };
    }

    /**
     * Determine which command to run based on arguments
     */
    determineCommand(argv: CliArgs): CommandType {
        if (argv["kill-server"]) {
            return "kill-server" as CommandType;
        }
        if (argv.mcp) {
            return "mcp" as CommandType;
        }
        if (argv.hover) {
            return "hover" as CommandType;
        }
        if (argv.diagnostics) {
            return "diagnostics" as CommandType;
        }

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
            return new LspServer({ cwd, debug: env.log.isDebugEnabled() });
        }
    }

    /**
     * Show help message
     */
    showHelp(): void {
        out.error("Usage: mcp-tsc [options] <file|directory|pattern> [...more]");
        out.error("");
        out.error("Commands:");
        out.error("  -d, --diagnostics    Check TypeScript files for errors (default)");
        out.error("  --hover              Get hover information at a specific location");
        out.error("  --mcp                Run as MCP server");
        out.error("  -k, --kill-server    Kill persistent LSP server(s)");
        out.error("");
        out.error("Options:");
        out.error("  --use-tsc            Use TypeScript Compiler API instead of LSP");
        out.error("  -w, --warnings       Show warnings in addition to errors");
        out.error("  -r, --root <path>    Override working directory (default: current directory)");
        out.error("  --timeout <seconds>  Timeout for diagnostics in seconds (default: 30)");
        out.error("");
        out.error("Hover Command Options:");
        out.error("  -l, --line <num>     Line number (required with --hover)");
        out.error("  -c, --char <num>     Character position (optional)");
        out.error("  -t, --text <string>  Text to search for on line (optional)");
        out.error("  --raw                Show full JSON with raw LSP data");
        out.error("");
        out.error("Examples:");
        out.error("  # Diagnostics");
        out.error("  mcp-tsc src/app.ts                            # single file (default command)");
        out.error("  mcp-tsc -d src                                # all TS files in src/");
        out.error("  mcp-tsc --diagnostics 'src/**/*.ts'           # glob pattern");
        out.error("  mcp-tsc -d -w src/app.ts                      # show warnings");
        out.error("  mcp-tsc --use-tsc src/app.ts                  # use compiler API");
        out.error("");
        out.error("  # Hover / Type Introspection");
        out.error("  mcp-tsc --hover -l 10 src/app.ts              # hover at line 10");
        out.error("  mcp-tsc --hover -l 10 -t myVar src/app.ts     # hover on 'myVar'");
        out.error("  mcp-tsc --hover -l 10 --raw src/app.ts        # include raw LSP data");
        out.error("");
        out.error("  # Server Management");
        out.error("  mcp-tsc --kill-server                         # kill server for current dir");
        out.error("  mcp-tsc -k --all                              # kill all servers");
        out.error("  mcp-tsc --mcp /path/to/project                # run as MCP server");
        out.error("");
        out.error("Note: LSP servers are persistent and reused across runs for better performance.");
    }
}
