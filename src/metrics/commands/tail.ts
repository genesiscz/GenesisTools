import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { eventLine } from "../lib/display";
import { withService } from "../lib/service";

interface TailFlags {
    json?: boolean;
    checkpoint?: boolean;
}

async function tail(project: string | undefined, metric: string | undefined, flags: TailFlags): Promise<void> {
    await withService(async (client) => {
        await withInterrupt(async (signal) => {
            const stop = await client.subscribe(
                {
                    ...(project ? { project } : {}),
                    ...(metric ? { metric } : {}),
                    ...(flags.checkpoint ? { withCheckpoint: true } : {}),
                },
                (event) => {
                    if (flags.json) {
                        out.print(`${SafeJSON.stringify(event, { strict: true })}\n`);
                        return;
                    }

                    out.println(
                        `${pc.cyan(`${event.project}/${event.metric}`)} ${pc.dim(event.door)} ${eventLine(event)}`
                    );
                }
            );
            out.printlnErr(`Listening for ${project ?? "every project"}${metric ? ` / ${metric}` : ""}; Ctrl-C stops.`);
            const closed = Promise.withResolvers<void>();
            client.socket.onClose(() => closed.resolve());
            signal.addEventListener("abort", () => closed.resolve(), { once: true });
            await closed.promise;
            stop();
        });
    });
}

export function registerTailCommand(program: Command): void {
    program
        .command("tail [project] [metric]")
        .description("Print events as the service takes them in (from the spool, ingest and imports) until Ctrl-C")
        .option("--json", "one JSON event per line")
        .option("--checkpoint", "name the checkpoint each event falls under")
        .action((project: string | undefined, metric: string | undefined, flags: TailFlags) =>
            tail(project, metric, flags)
        );
}
