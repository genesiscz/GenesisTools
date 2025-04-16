import * as watchman from "fb-watchman";
import minimist from "minimist";
import Enquirer from "enquirer";

const client = new watchman.Client();
const prompter = new Enquirer();

// Parse CLI arguments
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
        console.error("Invalid directory path provided:", arg);
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

    const choices = [
        ...dynamicChoices,
        { name: `Current directory (${process.cwd()})`, value: process.cwd() },
    ];

    const answer = await prompter.prompt({
        type: "autocomplete",
        maxChoices: 1,
        name: "directory",
        message: "Select a directory to watch:",
        choices,
    }) as { directory: string };
    return answer.directory;
}

function makeSubscription(client: watchman.Client, watch: string, relativePath: string | undefined): void {
    const subscription: Record<string, unknown> = {
        // Match all files
        expression: ["allof", ["type", "f"]],
        // Interested fields
        fields: ["name", "size", "mtime_ms", "exists", "type"],
    };

    if (relativePath) {
        subscription["relative_root"] = relativePath;
    }

    client.command(["subscribe", watch, "mysubscription", subscription], (error, resp) => {
        if (error) {
            console.error("Failed to subscribe:", error);
            return;
        }
        console.log("Subscription", resp.subscribe, "established");
    });

    // Listen to subscription events
    client.on("subscription", (resp: any) => {
        if (resp.subscription !== "mysubscription") return;

        // Sort files by mtime_ms ascending (latest at the bottom)
        const sortedFiles = resp.files.slice().sort((a: any, b: any) => {
            return Number(a.mtime_ms) - Number(b.mtime_ms);
        });

        sortedFiles.forEach((file: any) => {
            const mtimeMs = +file.mtime_ms;
            const date = new Date(mtimeMs);
            const today = new Date();
            const dateTime = date.toDateString() === today.toDateString() ? date.toLocaleTimeString() : date.toLocaleString();
            console.log(`${dateTime} File changed: ${file.name}`);
        });
    });
}

(async () => {
    const dirOfInterest = await getDirOfInterest();
    console.log("Directory of interest:", dirOfInterest);

    // Capability check and watch initialization
    client.capabilityCheck({ optional: [], required: ["relative_root"] }, (capabilityError, capabilityResp) => {
        if (capabilityError) {
            console.error("Capability check failed:", capabilityError);
            client.end();
            return;
        }

        client.command(["watch-project", dirOfInterest], (watchError, watchResp: any) => {
            if (watchError) {
                console.error("Error initiating watch:", watchError);
                client.end();
                return;
            }

            if ("warning" in watchResp) {
                console.warn("Warning:", watchResp.warning);
            }

            console.log("Watch established on", watchResp.watch, "relative_path:", watchResp.relative_path);
            makeSubscription(client, watchResp.watch, watchResp.relative_path);
        });
    });
})();

// `