import { Command } from "commander";

function showHelp() {
    // Write help to stderr to avoid polluting stdout
    process.stderr.write(`
Usage: tools mcp-debug [<command> [args...]]

Debug tool for MCP server configurations. Executes a command and outputs both:
- Debug information to stderr (visible in Cursor's debug console)
- Valid JSON to stdout (for Cursor to parse)

Arguments:
  <command>      Command to execute (e.g., "which", "env")
                 Optional if COMMANDS environment variable or --env is provided
  [args...]      Arguments to pass to the command

Options:
  --env          Execute 'env' command automatically (no other commands needed)
  -v, --verbose  Enable verbose logging
  -h, --help     Show this help message

Environment Variables:
  COMMANDS  Semicolon-delimited list of commands to execute
            If provided, primary command argument is optional
            Example: "env;which playwright;echo test"

Examples:
  tools mcp-debug which playwright
  tools mcp-debug --env
  tools mcp-debug --env which playwright
  COMMANDS="env;which playwright" tools mcp-debug echo "test"
  COMMANDS="env;which playwright" tools mcp-debug
`);
}

// Helper to write debug messages to stderr explicitly
function debugLog(message: string) {
    process.stderr.write(`[MCP-DEBUG] ${message}\n`);
}

async function executeCommand(commandString: string): Promise<any> {
    // Parse command string - handle quoted arguments
    const parts = commandString.trim().split(/\s+/);
    if (parts.length === 0 || !parts[0]) {
        throw new Error(`Invalid command: "${commandString}"`);
    }

    const [command, ...args] = parts;

    debugLog(`Executing command: ${command} ${args.join(" ")}`);

    try {
        // Execute the command
        const proc = Bun.spawn({
            cmd: [command, ...args],
            cwd: process.cwd(),
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        // Capture stdout and stderr
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        // Log to stderr for debugging
        debugLog(`Exit code: ${exitCode}`);
        debugLog(`stdout: ${stdout.trim()}`);
        if (stderr.trim()) {
            debugLog(`stderr: ${stderr.trim()}`);
        }

        return {
            success: exitCode === 0,
            exitCode,
            command: commandString.trim(),
            stdout: stdout.trim(),
            stderr: stderr.trim(),
        };
    } catch (error: any) {
        debugLog(`Error executing command "${commandString}": ${error.message || String(error)}`);
        return {
            success: false,
            exitCode: 1,
            command: commandString.trim(),
            error: error.message || String(error),
            stdout: "",
            stderr: "",
        };
    }
}

async function main() {
    const program = new Command()
        .name("mcp-debug")
        .description("Debug tool for MCP server configurations")
        .option("-v, --verbose", "Enable verbose logging")
        .option("-e, --env", "Execute 'env' command automatically")
        .option("--help-full", "Show extended help (use --help-full, not -h)")
        .argument("[command...]", "Command and arguments to execute")
        .parse();

    const options = program.opts();

    if (options.helpFull) {
        showHelp();
        process.exit(0);
    }

    // Get command and arguments
    const commandArgs = program.args;
    const commandsEnv = process.env.COMMANDS;
    const useEnv = options.env;

    // Check if we have either a command argument, COMMANDS env var, or --env flag
    if (commandArgs.length === 0 && !commandsEnv && !useEnv) {
        // Write error to stderr, not stdout
        process.stderr.write(
            "Error: No command provided, COMMANDS environment variable not set, and --env not specified\n"
        );
        showHelp();
        process.exit(1);
    }

    // Log what we're about to execute (to stderr only)
    debugLog(`Working directory: ${process.cwd()}`);
    debugLog(`Environment variables: ${JSON.stringify(process.env, null, 2)}`);

    // Build list of commands to execute
    const commandsToExecute: string[] = [];

    // Add 'env' command if --env flag is set
    if (useEnv) {
        //commandsToExecute.push("env");
        debugLog(`--env flag set, will execute 'env' command`);
        debugLog(JSON.stringify(process.env, null, 2));
    }

    // Add primary command if provided
    if (commandArgs.length > 0) {
        const primaryCommand = commandArgs.join(" ");
        commandsToExecute.push(primaryCommand);
    }

    // Add commands from COMMANDS environment variable
    if (commandsEnv) {
        const additionalCommands = commandsEnv
            .split(";")
            .map((cmd) => cmd.trim())
            .filter((cmd) => cmd.length > 0);
        commandsToExecute.push(...additionalCommands);
        debugLog(`Found COMMANDS: ${commandsEnv}`);
    }

    debugLog(`Will execute ${commandsToExecute.length} command(s)`);

    // Execute all commands
    const results: Array<{
        success: boolean;
        exitCode: number;
        command: string;
        stdout: string;
        stderr: string;
        error?: string;
    }> = [];
    let overallSuccess = true;
    let overallExitCode = 0;

    for (const cmd of commandsToExecute) {
        const result = await executeCommand(cmd);
        results.push(result);

        if (!result.success) {
            overallSuccess = false;
            overallExitCode = result.exitCode || 1;
        }
    }

    // Ensure stderr is flushed before writing to stdout
    await new Promise((resolve) => {
        if (process.stderr.writable) {
            process.stderr.write("", () => resolve(undefined));
        } else {
            resolve(undefined);
        }
    });

    // Output ONLY valid JSON to stdout for Cursor to parse
    const output = {
        success: overallSuccess,
        exitCode: overallExitCode,
        cwd: process.cwd(),
        env: process.env,
        commands: results,
    };

    // Write JSON directly to stdout (not console.log which might buffer)
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");

    // Exit with the overall exit code
    process.exit(overallExitCode);
}

main().catch((err) => {
    // Write error to stderr, not stdout
    process.stderr.write(`\n✖ Unexpected error: ${err}\n`);
    process.exit(1);
});
