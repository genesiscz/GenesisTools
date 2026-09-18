import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { DEMO_NAMES, refuseUserMail, runDemo } from "../lib/demo/reel";

export function registerDemoReel(program: Command): void {
    const control = program.commands.find((command) => command.name() === "control");
    const parent =
        control ?? program.command("control").description("All macOS control commands using this Jev checkout");
    parent
        .command("demo")
        .description("Run a fixture reel; refuses to call success without exact readback")
        .argument("[name]", `Demo name: ${DEMO_NAMES.join("|")}`, "route")
        .option("--app <name>", "Rejected unless the AppKit fixture or --i-mean-it")
        .option("--i-mean-it", "Break-glass to name a real app")
        .option("--record", "Capture is skipped when the platform cannot record")
        .action(async (name: string, options: { app?: string; iMeanIt?: boolean; record?: boolean }) => {
            try {
                refuseUserMail(options.app, options.iMeanIt === true);
            } catch (error) {
                out.log.error(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
                return;
            }

            const summary = await runDemo(name);
            out.result({
                ...summary,
                record: options.record === true ? "capture skipped" : undefined,
            });
            if (!summary.ok) {
                process.exitCode = 1;
            }
        });
}
