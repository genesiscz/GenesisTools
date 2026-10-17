import { PROVIDERS } from "@app/domains/lib/providers/registry";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus } from "@genesiscz/utils/table";
import { Command } from "commander";
import pc from "picocolors";

/** Read-only: reports which providers can run here. Never refreshes a token or writes a file. */
export function createProvidersCommand(): Command {
    return new Command("providers")
        .description("List availability and price providers, and whether each is configured")
        .option("--json", "print JSON to stdout")
        .action(async (opts) => {
            const rows = await Promise.all(
                PROVIDERS.map(async (provider) => ({
                    id: provider.id,
                    label: provider.label,
                    capabilities: provider.capabilities,
                    ...(await provider.status()),
                }))
            );

            if (opts.json) {
                out.result({ providers: rows });
                return;
            }

            const table = createBoxTable(["ID", "PROVIDER", "STATE", "CAN", "AUTH"]);
            for (const row of rows) {
                const can = Object.entries(row.capabilities)
                    .filter(([, on]) => on)
                    .map(([name]) => name)
                    .join(", ");
                table.push([
                    pc.white(row.id),
                    row.label,
                    formatDotStatus(row.configured ? "ok" : "dim", row.configured ? "ready" : "off"),
                    pc.dim(can),
                    pc.dim(row.detail),
                ]);
            }

            out.println(table.toString());
            out.println(
                pc.dim(
                    "Default chain: DNS, then the first ready priced registrar, then RDAP. TLD list prices: Porkbun."
                )
            );
        });
}
