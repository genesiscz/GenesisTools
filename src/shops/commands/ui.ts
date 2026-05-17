import { launchShopsDashboard } from "@app/shops/lib/ui-launcher";
import type { Command } from "commander";

export function registerUiCommand(program: Command): void {
    program
        .command("ui")
        .alias("dashboard")
        .description("Launch the Shops dashboard web UI on http://localhost:3073")
        .action(async () => {
            try {
                const exitCode = await launchShopsDashboard();
                if (exitCode !== 0) {
                    process.stderr.write(`\n× Vite exited with code ${exitCode}\n`);
                }

                process.exit(exitCode);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`× ${msg}\n`);
                process.exit(1);
            }
        });
}
