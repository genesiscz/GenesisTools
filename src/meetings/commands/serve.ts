import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { logger, out } from "@genesiscz/utils/logger";
import { passStartGate, releaseStartGate } from "@genesiscz/utils/process/start-gate";
import { launchService, readLiveServiceEntry, stopService } from "@genesiscz/utils/rpc/service-host";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { type Command, Option } from "commander";
import { meetingsSourceRoot } from "../lib/service/api";
import { meetingsServiceDir } from "../lib/service/client";

const { log } = logger.scoped("meetings-service");

interface ServeFlags {
    detach?: boolean;
    status?: boolean;
    stop?: boolean;
    idle?: boolean;
    startGate?: string;
}

/** `--detach`: starts the service in its own process and prints its service.json once it listens. */
async function detach(): Promise<void> {
    const launch = await launchService({
        dir: meetingsServiceDir(),
        command: ["meetings", "serve"],
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

/**
 * `--stop`: stops the running service (SIGTERM, as Ctrl-C stops it) and prints the service.json it stopped. None
 * running is no failure: the state asked for holds.
 */
async function stop(): Promise<void> {
    const dir = meetingsServiceDir();
    const stopped = await stopService(dir);

    switch (stopped.status) {
        case "none":
            out.printlnErr(`No meetings service runs (${dir}/service.json names no live process)`);
            return;
        case "unverified":
            out.printlnErr(
                `pid ${stopped.entry.pid} in ${dir}/service.json may not be the meetings service any more; nothing was signalled. Check it with ps -p ${stopped.entry.pid}`
            );
            process.exitCode = 1;
            return;
        case "timeout":
            out.printlnErr(`The meetings service (pid ${stopped.entry.pid}) did not exit within 5 s of SIGTERM`);
            process.exitCode = 1;
            return;
        case "stopped":
            out.printlnErr(`Stopped the meetings service (pid ${stopped.entry.pid})`);
            out.result(stopped.entry);
            return;
    }
}

async function serve(flags: ServeFlags): Promise<void> {
    if (flags.stop) {
        await stop();
        return;
    }

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
        await detach();
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
        .option("--stop", "stop the running service and print the service.json it stopped (none running is no failure)")
        .option("--no-idle", "do not exit after 10 minutes with no connection")
        .addOption(new Option("--start-gate <path>", "the start gate of a --detach start").hideHelp())
        .action((flags: ServeFlags) => serve(flags));
}
