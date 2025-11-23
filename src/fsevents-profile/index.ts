import { spawn } from "bun";
import chalk from "chalk";
import Enquirer from "enquirer";
import * as fsevents from "fsevents";
import minimist from "minimist";
import * as path from "path";
import logger from "@app/logger";

// Define options interface
interface Options {
    duration?: number;
    top?: number;
    path?: string;
    verbose?: boolean;
    watchers?: boolean;
    help?: boolean;
}

interface Args extends Options {
    _: string[];
}

// Create Enquirer instance for interactive prompts
const _prompter = new Enquirer();

// Default configuration
const DEFAULT_DURATION = 15; // How long to monitor events.
const DEFAULT_TOP_N = 10; // How many top offenders to display.
const DEFAULT_PATH = "/"; // Default path to monitor

interface Event {
    path: string;
    event: string;
}

// Show help message
function showHelp() {
    logger.info(`
${chalk.bold("fsevents-profile")} - Profile file system events using fsevents

${chalk.bold("Usage:")}
  tools fsevents-profile [options] [path]

${chalk.bold("Arguments:")}
  [path]        Path to monitor (default: "/")

${chalk.bold("Options:")}
  -d, --duration <seconds>  How long to monitor events (default: ${DEFAULT_DURATION})
  -t, --top <number>        How many top directories to display (default: ${DEFAULT_TOP_N})
  -w, --watchers            Show processes currently watching fsevents
  -v, --verbose             Enable verbose logging
  -h, --help                Show this help message

${chalk.bold("Examples:")}
  tools fsevents-profile                    # Monitor entire filesystem for 15 seconds
  tools fsevents-profile /Users             # Monitor user directory for 15 seconds
  tools fsevents-profile -d 30              # Monitor for 30 seconds
  tools fsevents-profile -t 5 /tmp          # Monitor /tmp, show top 5 directories
  tools fsevents-profile --watchers         # Show processes watching fsevents

${chalk.bold("Notes:")}
  Press Ctrl+C at any time to stop monitoring early and see the analysis results.
`);
}

async function main() {
    // Parse command line arguments
    const argv = minimist<Args>(process.argv.slice(2), {
        alias: {
            d: "duration",
            t: "top",
            w: "watchers",
            v: "verbose",
            h: "help",
        },
        boolean: ["verbose", "help", "watchers"],
        default: {
            duration: DEFAULT_DURATION,
            top: DEFAULT_TOP_N,
            path: DEFAULT_PATH,
        },
    });

    // Show help if requested
    if (argv.help) {
        showHelp();
        process.exit(0);
    }

    // Show fsevents watchers if requested
    if (argv.watchers) {
        await showFseventsWatchers();
        process.exit(0);
    }

    // Get monitoring path
    let monitorPath = argv.path || argv._[0] || DEFAULT_PATH;

    // Validate duration
    if (argv.duration! <= 0) {
        logger.error("Duration must be a positive number");
        process.exit(1);
    }

    // Validate top count
    if (argv.top! <= 0) {
        logger.error("Top count must be a positive number");
        process.exit(1);
    }

    if (argv.verbose) {
        logger.info(`Monitoring path: ${monitorPath}`);
        logger.info(`Duration: ${argv.duration} seconds`);
        logger.info(`Top directories to show: ${argv.top}`);
    }

    logger.info(`Starting fsevents profiler for ${argv.duration} seconds...`);
    logger.info(`Monitoring file system events from "${monitorPath}"`);
    logger.info(`Press Ctrl+C to stop early and see results`);

    const events: Event[] = [];

    // Start watching the specified path
    const stopWatching = fsevents.watch(monitorPath, (path: string, flags: number, _id: string) => {
        const eventInfo = fsevents.getInfo(path, flags);
        events.push({ path: eventInfo.path, event: eventInfo.event });

        if (argv.verbose) {
            logger.info(`Event: ${eventInfo.event}(${eventInfo.type}) - ${eventInfo.path}`);
        }
    });

    // Function to gracefully stop and analyze
    const stopAndAnalyze = async () => {
        logger.info("\nStopping watcher and analyzing results...");
        try {
            await stopWatching();
            analyzeEvents(events, argv.top!);
            process.exit(0);
        } catch (error) {
            logger.error(`Error stopping watcher: ${error}`);
            process.exit(1);
        }
    };

    // Handle Ctrl+C (SIGINT) gracefully
    process.on("SIGINT", stopAndAnalyze);

    // After the specified duration, stop the watcher and analyze the data
    setTimeout(stopAndAnalyze, argv.duration! * 1000);
}

function analyzeEvents(events: Event[], topCount: number) {
    if (events.length === 0) {
        logger.info("No file system events were detected.");
        return;
    }

    logger.info(`\n${chalk.bold("--- Analysis Complete ---")}`);
    logger.info(`Total events captured: ${chalk.cyan(events.length.toLocaleString())}`);

    const directoryCounts: { [key: string]: number } = {};

    // Aggregate event counts by their parent directory.
    for (const event of events) {
        const dir = path.dirname(event.path);
        directoryCounts[dir] = (directoryCounts[dir] || 0) + 1;
    }

    // Sort directories by event count in descending order.
    const sortedDirectories = Object.entries(directoryCounts).sort(([, countA], [, countB]) => countB - countA);

    logger.info(`\n${chalk.bold(`Top ${topCount} most active directories:`)}`);
    logger.info("-------------------------------------------");

    sortedDirectories.slice(0, topCount).forEach(([dir, count]) => {
        logger.info(`${chalk.yellow(count.toString().padStart(6, " "))} events in ${chalk.green(dir)}`);
    });

    logger.info(`\n${chalk.bold("--- End of Report ---")}`);
    logger.info("Tip: Look for caches, build output directories, or cloud sync folders in the list above.");
}
async function showFseventsWatchers() {
    logger.info(chalk.bold("--- Fsevents Watchers Analysis (using fs_usage) ---"));

    if (process.env.USER !== "root") {
        logger.error("This command requires root privileges to run fs_usage.");
        logger.info(`Please re-run with sudo: ${chalk.cyan("sudo tools fsevents-profile --watchers")}`);
        process.exit(1);
    }

    logger.info("Sampling filesystem activity for 5 seconds to find watchers...");
    logger.info("Please wait...");

    const watchers: Map<string, { pids: Set<string>; command: string }> = new Map();

    try {
        const fsUsageProc = spawn({
            // -w gives wide output, making it easier to parse
            // We grep for the fsevents device to find processes accessing it.
            cmd: ["sh", "-c", "fs_usage -w | grep /dev/fsevents"],
            stdout: "pipe",
            stderr: "pipe",
        });

        // Let the process run for 5 seconds to collect data
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Politely ask the process to terminate
        fsUsageProc.kill("SIGKILL");

        console.log("fsUsageProc");
        const stdout = await new Response(fsUsageProc.stdout).text();
        await fsUsageProc.exited;

        const lines = stdout.trim().split("\n");

        // Regex to capture the process name and PID at the end of an fs_usage line
        // e.g., "10:30:01.123 open /dev/fsevents  0.000002   node.12345"
        const lineRegex = /\s+([\w.-]+)\.(\d+)$/;

        console.log("lines", lines.length);
        for (const line of lines) {
            const match = line.match(lineRegex);
            if (match) {
                const command = match[1];
                const pid = match[2];

                if (!watchers.has(command)) {
                    watchers.set(command, { pids: new Set(), command });
                }
                watchers.get(command)!.pids.add(pid);
            }
        }

        if (watchers.size === 0) {
            logger.info("\nNo active fsevents watchers detected during the sampling period.");
            logger.info("If you suspect this is wrong, try increasing the sampling duration.");
            return;
        }

        // Flatten the data to show each PID with its process name
        const pidList: Array<{ pid: string; command: string }> = [];
        for (const watcher of watchers.values()) {
            for (const pid of watcher.pids) {
                pidList.push({ pid, command: watcher.command });
            }
        }

        // Sort by PID numerically
        pidList.sort((a, b) => parseInt(a.pid) - parseInt(b.pid));

        logger.info(`\nFound ${chalk.cyan(pidList.length.toString())} process(es) watching fsevents:\n`);

        for (const { pid, command } of pidList) {
            logger.info(`${chalk.yellow(pid.padStart(6, " "))} - ${chalk.green(command)}`);
        }

        logger.info(`\n${chalk.bold("--- End of Watchers Report ---")}`);
    } catch (error) {
        logger.error(`Error analyzing fsevents watchers: ${error}`);
        process.exit(1);
    }
}

// Run the tool
main().catch((err) => {
    logger.error(`\n${chalk.red("✖ Unexpected error:")} ${err}`);
    process.exit(1);
});
