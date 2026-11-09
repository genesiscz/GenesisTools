import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { logger, out } from "@genesiscz/utils/logger";
import { passStartGate, releaseStartGate } from "@genesiscz/utils/process/start-gate";
import { type Command, Option } from "commander";
import { launchRecorderService } from "../lib/service-launch";
import { readLiveService, recorderServiceDir } from "../lib/service-protocol";

const { log } = logger.scoped("recorder-service");

interface ServeFlags {
    detach?: boolean;
    status?: boolean;
    idle?: boolean;
    startGate?: string;
}

/** `--detach`: starts the service in its own process and answers its service.json once it listens. */
async function detach(): Promise<void> {
    const launch = await launchRecorderService();

    if (launch.status === "failed") {
        out.printlnErr(launch.reason);
        process.exitCode = 1;
        return;
    }

    out.result(launch.entry);
}

async function serve(flags: ServeFlags): Promise<void> {
    if (flags.status) {
        const entry = readLiveService();

        if (!entry) {
            out.printlnErr(`No recorder service runs (${recorderServiceDir()}/service.json names no live process)`);
            process.exitCode = 1;
            return;
        }

        out.result(entry);
        return;
    }

    if (flags.detach) {
        await detach();
        return;
    }

    if (flags.startGate && (await passStartGate(flags.startGate)).status === "cancelled") {
        return;
    }

    try {
        // Loaded only here: the service pulls in the whole REPL toolset, which the other commands do not need.
        const { startRecorderService } = await import("../lib/service");
        await withInterrupt(
            async (signal) => {
                const start = await startRecorderService({
                    idleMs: flags.idle === false ? 0 : undefined,
                    sourceRoot: new URL("../../", import.meta.url).pathname,
                });

                if (start.status === "running") {
                    out.printlnErr(`A recorder service runs already (pid ${start.entry.pid}, ${start.entry.socket})`);
                    return;
                }

                const { service } = start;
                signal.addEventListener("abort", () => service.stop("signal"), { once: true });
                process.once("exit", () => service.stop("exit"));
                out.printlnErr(`recorder service listening on ${service.entry.socket} (pid ${process.pid})`);
                const reason = await service.stopped;
                log.info({ reason }, "recorder service process exiting");
            },
            { handleTermination: true }
        );
    } finally {
        if (flags.startGate) {
            releaseStartGate(flags.startGate);
        }
    }

    // The orphan watchdog, the fs watchers and the logger may keep the loop alive; the service is done.
    process.exit(0);
}

export function registerServeCommand(program: Command): void {
    program
        .command("serve")
        .description(
            "Run the recorder service: the one owner of the recordings' edits while it runs, and the way to GenesisTools.app's recorder face (windows, renders, the camera), on <recordings>/service.sock with service.json beside it. A second start finds the first and exits; it exits after 10 minutes with no connection and no open edit, and when its code changes"
        )
        .option("--detach", "start it in the background and print its service.json once it listens")
        .option("--status", "print the running service's service.json and exit (1 when none runs)")
        .option("--no-idle", "do not exit after 10 minutes with no connection and no open edit")
        .addOption(new Option("--start-gate <path>", "the start gate of a --detach start").hideHelp())
        .action((flags: ServeFlags) => serve(flags));
}
