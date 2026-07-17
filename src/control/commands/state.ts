import { logger, out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import pc from "picocolors";
import { ensureBinary, runAx } from "../lib/runner";

export function registerStateCommands(program: Command): void {
    program
        .command("snapshot")
        .description("Capture current mouse position + focused app/window")
        .option("--json", "raw JSON output")
        .action((opts) => {
            const result = runAx(["snapshot"]);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, 2));
                return;
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            const m = result.mouse as Record<string, number>;
            out.println(
                `${pc.green("snapshot")} app=${pc.cyan(String(result.app))} mouse=(${m?.x?.toFixed(0)},${m?.y?.toFixed(0)})`
            );
            out.println(pc.dim(`  restore with: tools control restore --snapshot '${SafeJSON.stringify(result)}'`));
        });

    program
        .command("restore")
        .description("Restore mouse position + focused app/window from a snapshot")
        .requiredOption("--snapshot <json>", "snapshot JSON from the snapshot command")
        .option("--json", "raw JSON output")
        .action((opts) => {
            const result = runAx(["restore", "--snapshot", opts.snapshot]);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, 2));
                return;
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            out.println(`${pc.green("restored")} app=${pc.cyan(String(result.app))}`);
        });

    program
        .command("build")
        .description("Build/rebuild the native ax-tool binary")
        .action(() => {
            try {
                out.println("Building ax-tool (Swift)...");
                const path = ensureBinary();
                out.println(`${pc.green("built")} ${path}`);
            } catch (e) {
                logger.error(e instanceof Error ? e.message : String(e));
                process.exit(1);
            }
        });
}
