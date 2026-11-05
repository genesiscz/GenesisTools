import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatDuration } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import { gateLedger, raiseGate } from "../lib/gates/index";

/**
 * `tools hub gates`: what waits on the Mac's Touch ID, as the phone's waiting card shows it (`/api/gateway/gates`),
 * and `tools hub gates raise <id>`, the card's button (`POST /api/gates/raise`). Neither answers a gate.
 */
export function registerGatesCommand(program: Command): void {
    const gates = program
        .command("gates")
        .description("What waits on the Mac's Touch ID: vault and AI account windows and rm requests")
        .option("--json", "machine-readable output")
        .action((opts: { json?: boolean }) => {
            const ledger = gateLedger();

            if (opts.json) {
                out.result(ledger);
                return;
            }

            renderCliHeader("Waiting on Touch ID", `${ledger.pending.length} waiting`);
            const table = createBoxTable(["ID", "GATE", "WHAT", "WHO", "WAITED", "WINDOW"]);
            const now = Date.now();

            for (const wait of ledger.pending) {
                table.push([
                    truncateDisplay(wait.id, 22),
                    wait.gate,
                    truncateDisplay(wait.title, 40),
                    truncateDisplay(wait.who ?? "", 22),
                    formatDuration(now - Date.parse(wait.askedAt)),
                    wait.window ? `open, pid ${wait.window.pid}` : "none",
                ]);
            }

            out.println(table.toString());
        });

    gates
        .command("raise")
        .description("Bring a waiting window to the front, or open the window of an rm request that has none")
        .argument("<id>", `a ledger id from \`${toolCommand("hub gates")}\``)
        .option("--json", "machine-readable output")
        .action(async (id: string, opts: { json?: boolean }) => {
            const receipt = await raiseGate(id);
            process.exitCode = receipt.outcome === "gone" ? 1 : 0;

            if (opts.json) {
                out.result(receipt);
                return;
            }

            out.log.info(`${receipt.outcome}: ${receipt.detail}`);
        });
}
