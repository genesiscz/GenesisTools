import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { logger, out } from "@genesiscz/utils/logger";
import { passStartGate, releaseStartGate } from "@genesiscz/utils/process/start-gate";
import { launchService, readLiveServiceEntry } from "@genesiscz/utils/rpc/service-host";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { type Command, Option } from "commander";
import { meetingsSourceRoot } from "../lib/service/api";
import { meetingsServiceDir } from "../lib/service/client";

const { log } = logger.scoped("meetings-service");

interface ServeFlags {
    detach?: boolean;
    status?: boolean;
    idle?: boolean;
    startGate?: string;
}

/**
 * `--detach`: starts the service in its own process and prints its service.json once it listens. The flags the
 * service itself reads (`--no-idle`) go with it; a running service is answered as it is.
 */
async function detach(flags: ServeFlags): Promise<void> {
    const launch = await launchService({
        dir: meetingsServiceDir(),
        command: ["meetings", "serve", ...(flags.idle === false ? ["--no-idle"] : [])],
        gates: toolDataDir("meetings", "start-gates"),
        label: "meetings service",
    });

    if (launch.status === "failed") {
        out.printlnErr(launch.reason);
        process.exitCode = 1;
        return;
    }

    out.result(launch.entry);
}

async function serve(flags: ServeFlags): Promise<void> {
    if (flags.status) {
        const entry = readLiveServiceEntry(meetingsServiceDir());

        if (!entry) {
            out.printlnErr(`No meetings service runs (${meetingsServiceDir()}/service.json names no live process)`);
            process.exitCode = 1;
            return;
        }

        out.result(entry);
        return;
    }

    if (flags.detach) {
        await detach(flags);
        return;
    }

    if (flags.startGate && (await passStartGate(flags.startGate)).status === "cancelled") {
        return;
    }

    try {
        const { startMeetingsService } = await import("../lib/service/service");
        await withInterrupt(
            async (signal) => {
                const start = await startMeetingsService({
                    idleMs: flags.idle === false ? 0 : undefined,
                    sourceRoot: meetingsSourceRoot(),
                });

                if (start.status === "running") {
                    out.printlnErr(`A meetings service runs already (pid ${start.entry.pid}, ${start.entry.socket})`);
                    return;
                }

                const { service } = start;
                signal.addEventListener("abort", () => service.stop("signal"), { once: true });
                process.once("exit", () => service.stop("exit"));
                out.printlnErr(`meetings service listening on ${service.entry.socket} (pid ${process.pid})`);
                const reason = await service.stopped;
                log.info({ reason }, "meetings service process exiting");
            },
            { handleTermination: true }
        );
    } finally {
        if (flags.startGate) {
            releaseStartGate(flags.startGate);
        }
    }

    // The logger and the fs watchers may keep the loop alive; the service is done.
    process.exit(0);
}

export function registerServeCommand(program: Command): void {
    program
        .command("serve")
        .description(
            "Run the Meetings service: the one owner of the meetings store while it runs, answering the window, the CLI and agents over <genesis-tools>/meetings-service/service.sock with service.json beside it. A second start finds the first and exits; it exits after 10 minutes with no connection, and when its code changes"
        )
        .option("--detach", "start it in the background and print its service.json once it listens")
        .option("--status", "print the running service's service.json and exit (1 when none runs)")
        .option("--no-idle", "do not exit after 10 minutes with no connection")
        .addOption(new Option("--start-gate <path>", "the start gate of a --detach start").hideHelp())
        .action((flags: ServeFlags) => serve(flags));
}
