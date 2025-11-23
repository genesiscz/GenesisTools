import * as watchman from "fb-watchman";
import minimist from "minimist";
import Enquirer from "enquirer";
import logger from "@app/logger";

const client = new watchman.Client();
const prompter = new Enquirer();

const argv = minimist(process.argv.slice(2), {
    alias: { c: "current" },
    boolean: ["current"],
});

async function getDirOfInterest(): Promise<string> {
    // If -c or --current is passed, use process.cwd()
    if (argv.current) {
        return process.cwd();
    }

    // If a positional argument is provided, try to resolve it
    const arg = argv._[0];
    if (arg) {
        if (arg.startsWith(".") || arg.startsWith("/")) {
            return arg;
        }
        logger.error("Invalid directory path provided:", arg);
    }

    // No valid argument, show interactive selection
    // Get watched directories from watchman
    const watchedDirs: string[] = await new Promise((resolve) => {
        client.command(["watch-list"], (err, resp) => {
            if (err || !resp || !resp.roots) return resolve([]);
            resolve(resp.roots);
        });
    });
    const dynamicChoices = watchedDirs.map((dir) => ({ name: `watchman: ${dir}`, value: dir }));

    const choices = [...dynamicChoices, { name: `Current directory (${process.cwd()})`, value: process.cwd() }];

    const answer = (await prompter.prompt({
        type: "autocomplete",
        maxChoices: 1,
        name: "directory",
        message: "Select a directory to watch:",
        choices,
    })) as { directory: string };
    return answer.directory;
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
        subscription["relative_root"] = relativePath;
    }

    client.command(["subscribe", watch, "mysubscription", subscription], (error, resp) => {
        if (error) {
            if (retryCount < 15) {
                logger.error(`Failed to subscribe (attempt ${retryCount + 1}/15):`, error);
                setTimeout(() => makeSubscription(client, watch, relativePath, retryCount + 1), 1000);
            } else {
                logger.error("Failed to subscribe after 15 attempts. Exiting.");
                client.end();
                process.exit(1);
            }
            return;
        }
        logger.info("Subscription", resp.subscribe, "established");
    });

    // Remove any previous listeners to avoid duplicates
    client.removeAllListeners("subscription");
    client.on("subscription", (resp: any) => {
        if (resp.subscription !== "mysubscription") return;
        if (!resp.files || !Array.isArray(resp.files)) {
            // No files in the response, nothing to do
            return;
        }
        // Sort files by mtime_ms ascending (latest at the bottom)
        const sortedFiles = resp.files.slice().sort((a: any, b: any) => {
            return Number(a.mtime_ms) - Number(b.mtime_ms);
        });

        sortedFiles.forEach((file: any) => {
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
    let lastError: any = null;
    while (attempt < maxRetries) {
        const client = new (require("fb-watchman").Client)();
        await new Promise((resolve) => {
            client.capabilityCheck(
                { optional: [], required: ["relative_root"] },
                (capabilityError: any, capabilityResp: any) => {
                    if (capabilityError) {
                        logger.error(
                            `Capability check failed (attempt ${attempt + 1}/${maxRetries}):`,
                            capabilityError
                        );
                        lastError = capabilityError;
                        attempt++;
                        client.end();
                        setTimeout(resolve, 1000);
                        return;
                    }
                    client.command(["watch-project", dirOfInterest], (watchError: any, watchResp: any) => {
                        if (watchError) {
                            logger.error(`Error initiating watch (attempt ${attempt + 1}/${maxRetries}):`, watchError);
                            lastError = watchError;
                            attempt++;
                            client.end();
                            setTimeout(resolve, 1000);
                            return;
                        }
                        if ("warning" in watchResp) {
                            logger.warn("Warning:", watchResp.warning);
                        }
                        logger.info("Watch established on", watchResp.watch, "relative_path:", watchResp.relative_path);
                        makeSubscription(client, watchResp.watch, watchResp.relative_path);
                        attempt = maxRetries;
                        resolve(undefined);
                    });
                }
            );
        });
        if (attempt === maxRetries) {
            return;
        }
    }
    logger.error("Failed to establish watch after 15 attempts. Exiting.", lastError);
    process.exit(1);
}

(async () => {
    const dirOfInterest = await getDirOfInterest();
    logger.info("Directory of interest:", dirOfInterest);
    await watchWithRetry(dirOfInterest);
})();
