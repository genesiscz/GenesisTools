import { suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { enabledServers, loadRegistry } from "../lib/registry.ts";

export function registerServers(program: Command): void {
    program
        .command("servers")
        .description("List MCP servers mcp-manager knows about, with transport details")
        .option("--json", "Machine-readable output")
        .option("--refresh", "Re-scan the provider configs instead of the cache")
        .option("--all", "Include servers that are disabled everywhere")
        .action(async (opts: { json?: boolean; refresh?: boolean; all?: boolean }) => {
            const registry = await loadRegistry({ refresh: opts.refresh });
            const list = opts.all ? registry.servers : enabledServers(registry);

            if (opts.json) {
                out.result({ ...registry, servers: list });
                return;
            }

            renderCliHeader(
                "MCP servers",
                `${list.length} of ${registry.servers.length} · cached ${registry.fetchedAt}`
            );
            const table = createBoxTable(["SERVER", "STATE", "TRANSPORT", "WHERE"]);

            for (const s of list) {
                const where = s.connection.type === "stdio" ? s.connection.command : s.connection.url;
                table.push([
                    pc.white(s.name),
                    formatDotStatus(s.enabled ? "ok" : "err", s.status),
                    pc.dim(s.connection.type),
                    pc.dim(truncateDisplay(where, 60)),
                ]);
            }

            out.println(table.toString());

            for (const failed of registry.providersFailed) {
                ui.warn(`${failed.provider}: ${failed.error}`);
            }

            ui.dim(suggestCommand("tools scripts", { replaceCommand: ["tools", "'<server>.*'"] }));
        });
}
