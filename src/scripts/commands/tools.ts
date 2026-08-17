import { suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { firstLine, resolveSelectors, signatureOf } from "../lib/discover.ts";

export function registerTools(program: Command): void {
    program
        .command("tools [selectors...]")
        .description(
            "List tools matching selectors like 'server.*' or '*.take_*'. No selector lists every enabled server."
        )
        .option("--json", "Machine-readable output")
        .option("--schema", "Include the full input schema (verbose; prefer the default signatures)")
        .option("--names", "Names only, no signatures or descriptions")
        .option("--grep <text>", "Substring match over tool name and description")
        .option("--refresh", "Re-probe servers instead of using the tool cache")
        .action(
            async (
                selectors: string[],
                opts: { json?: boolean; schema?: boolean; names?: boolean; grep?: string; refresh?: boolean }
            ) => {
                const wanted = selectors.length > 0 ? selectors : ["*.*"];
                const resolved = await resolveSelectors(wanted, { refresh: opts.refresh });
                const needle = opts.grep?.toLowerCase();
                const matched = needle
                    ? resolved.matched.filter(
                          ({ tool }) =>
                              tool.name.toLowerCase().includes(needle) ||
                              (tool.description ?? "").toLowerCase().includes(needle)
                      )
                    : resolved.matched;

                if (opts.json) {
                    out.result({
                        tools: matched.map(({ server, tool }) => ({
                            ref: `${server}.${tool.name}`,
                            server,
                            name: tool.name,
                            description: tool.description,
                            ...(opts.schema ? { inputSchema: tool.inputSchema, outputSchema: tool.outputSchema } : {}),
                        })),
                        errors: resolved.errors,
                    });
                    return;
                }

                let currentServer = "";

                for (const { server, tool } of matched) {
                    if (server !== currentServer) {
                        currentServer = server;
                        ui.raw("");
                        ui.header(server);
                    }

                    if (opts.names) {
                        ui.raw(`  ${tool.name}`);
                    } else {
                        // signature first: it is what you need to write a call, and it
                        // is far cheaper than dumping the whole schema.
                        ui.raw(`  ${signatureOf(tool.name, tool.inputSchema)}`);

                        const desc = firstLine(tool.description, 100);

                        if (desc) {
                            ui.raw(pc.dim(`      ${desc}`));
                        }
                    }

                    if (opts.schema) {
                        const dump = SafeJSON.stringify(tool.inputSchema, { strict: true }, 2)
                            .split("\n")
                            .map((l) => `      ${l}`)
                            .join("\n");
                        ui.raw(pc.dim(dump));
                    }
                }

                ui.raw("");
                ui.raw(`${matched.length} tool(s)`);

                for (const e of resolved.errors) {
                    ui.err(`${e.server}: ${e.error.slice(0, 160)}`);
                }

                ui.dim(
                    `detail: ${suggestCommand("tools scripts", { replaceCommand: ["describe", "'<server>.<tool>'"] })}`
                );
            }
        );
}
