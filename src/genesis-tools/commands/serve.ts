import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { ensureGenesisToolsService, genesisToolsSourceRoot } from "@genesiscz/utils/genesis-tools/service/clients";
import { startGenesisToolsService } from "@genesiscz/utils/genesis-tools/service/host";
import { out } from "@genesiscz/utils/logger";
import { passStartGate, releaseStartGate } from "@genesiscz/utils/process/start-gate";
import { type Command, Option } from "commander";
import { registerCliAppBuilder } from "../lib/app-builder";
import { registerCliWorkDoor } from "../lib/work-door";

export function registerServeCommand(program: Command): void {
    program
        .command("serve")
        .description("Serve actions and person requests; exit after ten idle minutes")
        .option("--detach", "start the service on demand and return once it is listening")
        .addOption(new Option("--start-gate <path>").hideHelp())
        .action(async (options: { startGate?: string; detach?: boolean }) => {
            if (options.detach) {
                const client = await ensureGenesisToolsService();
                client.close();
                out.result({ running: true });
                return;
            }
            if (options.startGate && (await passStartGate(options.startGate)).status === "cancelled") {
                return;
            }
            try {
                await withInterrupt(
                    async (signal) => {
                        registerCliAppBuilder();
                        registerCliWorkDoor();
                        const start = await startGenesisToolsService({ sourceRoot: genesisToolsSourceRoot() });
                        if (start.status === "running") {
                            out.printlnErr("A GenesisTools service is already running.");
                            return;
                        }
                        const stop = (): void => start.host.stop("signal");
                        signal.addEventListener("abort", stop, { once: true });

                        // A signal that came while the service started fired no event; it still stops the service.
                        if (signal.aborted) {
                            stop();
                        }

                        process.once("exit", () => start.host.stop("exit"));
                        out.printlnErr(
                            `GenesisTools service listening on ${start.host.entry.socket} (pid ${process.pid})`
                        );
                        await start.host.stopped;
                    },
                    { handleTermination: true }
                );
            } finally {
                if (options.startGate) {
                    releaseStartGate(options.startGate);
                }
            }
        });
}
