import * as fs from "node:fs";
import * as path from "node:path";
import logger from "@app/logger";
import { handleReadmeFlag } from "@app/utils/readme";
import { ExitPromptError } from "@inquirer/core";
import { search } from "@inquirer/prompts";
import { Command } from "commander";
import * as watchman from "fb-watchman";

interface WatchmanFile {
    name: string;
    size: number;
    mtime_ms: number;
    exists: boolean;
    type: string;
}

interface WatchmanResponse {
    roots?: string[];
    subscribe?: string;
    subscription?: string;
    files?: WatchmanFile[];
    watch?: string;
    relative_path?: string;
    warning?: string;
}

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

const client = new watchman.Client();

// Parse command line arguments using Commander
const program = new Command()
    .option("-c, --current", "Use current working directory")
    .option("-?, --help-full", "Show detailed help message")
    .parse();

const options = program.opts<{ current?: boolean; helpFull?: boolean }>();

if (options.helpFull) {
    console.log(`
Usage: tools watchman [options] [directory]

Watch a directory for file changes using Facebook's Watchman.

Arguments:
  [directory]        Path to directory to watch (relative or absolute)

Options:
  -c, --current      Use current working directory
  -?, --help-full    Show this detailed help message

If no directory is provided, you'll be prompted to select from:
  - Currently watched directories in Watchman
  - Current working directory

Examples:
  tools watchman                    # Interactive directory selection
  tools watchman .                  # Watch current directory
  tools watchman /path/to/project   # Watch specific directory
  tools watchman -c                 # Watch current directory (no prompt)
`);
    process.exit(0);
}

async function getDirOfInterest(): Promise<string> {
    // If -c or --current is passed, use process.cwd()
    if (options.current) {
        return process.cwd();
    }

    // If a positional argument is provided, try to resolve it
    const args = program.args;
    const arg = args[0];
    if (arg) {
        // Resolve relative paths to absolute
        const resolved = path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
        try {
            const stats = fs.statSync(resolved);
            if (stats.isDirectory()) {
                return resolved;
            }
            logger.error(`Path exists but is not a directory: ${arg} (resolved to ${resolved})`);
        } catch (err) {
            const errCode = (err as NodeJS.ErrnoException).code;
            if (errCode === "ENOENT") {
                logger.error(`Directory does not exist: ${arg} (resolved to ${resolved})`);
            } else {
                throw err;
            }
        }
    }

    // No valid argument, show interactive selection
    // Get watched directories from watchman
    const watchedDirs: string[] = await new Promise((resolve) => {
        // biome-ignore lint/suspicious/noExplicitAny: fb-watchman Client lacks command() in types
        (client as any).command(["watch-list"], (err: unknown, resp: WatchmanResponse) => {
            if (err || !resp || !resp.roots) {
                client.end(); // Close client on error
                return resolve([]);
            }
            resolve(resp.roots);
        });
    });

    const allChoices = [
        ...watchedDirs.map((dir) => ({
            name: `watchman: ${dir}`,
            value: dir,
        })),
        {
            name: `Current directory (${process.cwd()})`,
            value: process.cwd(),
        },
    ];

    try {
        const selected = await search({
            message: "Select a directory to watch:",
            source: async (term) => {
                if (!term) {
                    return allChoices;
                }
                return allChoices.filter((c) => c.value.toLowerCase().includes(term.toLowerCase()));
            },
        });
        return selected;
    } catch (error) {
        if (error instanceof ExitPromptError) {
            client.end(); // Close client before exit
            logger.info("Directory selection cancelled by user.");
            process.exit(0);
        }
        client.end(); // Close client on error
        throw error;
    }
}

function makeSubscription(
    client: watchman.Client,
    watch: string,
    relativePath: string | undefined,
    retryCount = 0
): void {
    const subscription: Record<string, unknown> = {
        // Match all files
        expression: ["allof", ["type", "f"]],
        fields: ["name", "size", "mtime_ms", "exists", "type"],
    };

    if (relativePath) {
        subscription.relative_root = relativePath;
    }

    // biome-ignore lint/suspicious/noExplicitAny: fb-watchman Client lacks command() in types
    (client as any).command(
        ["subscribe", watch, "mysubscription", subscription],
        (error: unknown, resp: WatchmanResponse) => {
            if (error) {
                if (retryCount < 15) {
                    logger.error(`Failed to subscribe (attempt ${retryCount + 1}/15): ${error}`);
                    setTimeout(() => makeSubscription(client, watch, relativePath, retryCount + 1), 1000);
                } else {
                    logger.error("Failed to subscribe after 15 attempts. Exiting.");
                    client.end();
                    process.exit(1);
                }
                return;
            }
            logger.info(`Subscription ${resp.subscribe} established`);
        }
    );

    // Remove any previous listeners to avoid duplicates
    client.removeAllListeners("subscription");
    // biome-ignore lint/suspicious/noExplicitAny: fb-watchman subscription event lacks proper types
    client.on("subscription", (resp: any) => {
        if (resp.subscription !== "mysubscription") {
            return;
        }
        if (!resp.files || !Array.isArray(resp.files)) {
            // No files in the response, nothing to do
            return;
        }
        // Sort files by mtime_ms ascending (latest at the bottom)
        const sortedFiles = resp.files.slice().sort((a: WatchmanFile, b: WatchmanFile) => {
            return Number(a.mtime_ms) - Number(b.mtime_ms);
        });

        sortedFiles.forEach((file: WatchmanFile) => {
            const mtimeMs = +file.mtime_ms;
            const date = new Date(mtimeMs);
            const today = new Date();
            const dateTime =
                date.toDateString() === today.toDateString() ? date.toLocaleTimeString() : date.toLocaleString();
            logger.info(`${dateTime} File changed: ${file.name}`);
        });
    });
}

async function watchWithRetry(dirOfInterest: string, maxRetries = 15) {
    let attempt = 0;
    let lastError: unknown = null;
    while (attempt < maxRetries) {
        const client = new (require("fb-watchman").Client)();
        await new Promise((resolve) => {
            client.capabilityCheck(
                { optional: [], required: ["relative_root"] },
                (capabilityError: unknown, _capabilityResp: unknown) => {
                    if (capabilityError) {
                        logger.error(
                            `Capability check failed (attempt ${attempt + 1}/${maxRetries}): ${capabilityError}`
                        );
                        lastError = capabilityError;
                        attempt++;
                        client.end();
                        setTimeout(resolve, 1000);
                        return;
                    }
                    // biome-ignore lint/suspicious/noExplicitAny: fb-watchman Client lacks command() in types
                    (client as any).command(
                        ["watch-project", dirOfInterest],
                        (watchError: unknown, watchResp: WatchmanResponse) => {
                            if (watchError) {
                                logger.error(
                                    `Error initiating watch (attempt ${attempt + 1}/${maxRetries}): ${watchError}`
                                );
                                lastError = watchError;
                                attempt++;
                                client.end();
                                setTimeout(resolve, 1000);
                                return;
                            }
                            if ("warning" in watchResp && watchResp.warning) {
                                logger.warn(`Warning: ${watchResp.warning}`);
                            }

                            if (!watchResp.watch) {
                                logger.error("watch-project response missing watch root");
                                lastError = new Error("watch-project response missing watch root");
                                attempt++;
                                client.end();
                                setTimeout(resolve, 1000);
                                return;
                            }

                            logger.info(
                                `Watch established on ${watchResp.watch} relative_path: ${watchResp.relative_path}`
                            );
                            makeSubscription(client, watchResp.watch ?? "", watchResp.relative_path);
                            attempt = maxRetries;
                            resolve(undefined);
                        }
                    );
                }
            );
        });
        if (attempt === maxRetries) {
            return;
        }
    }
    logger.error(`Failed to establish watch after 15 attempts. Exiting. ${lastError}`);
    process.exit(1);
}

(async () => {
    const dirOfInterest = await getDirOfInterest();
    logger.info(`Directory of interest: ${dirOfInterest}`);
    await watchWithRetry(dirOfInterest);
})();
