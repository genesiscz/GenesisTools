import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { firstLine, paramsOf, resolveSelectors, signatureOf } from "../lib/discover.ts";

export function registerDescribe(program: Command): void {
    program
        .command("describe <ref>")
        .description("Full detail for one tool: every parameter with type, required flag and description.")
        .option("--json", "Machine-readable output")
        .option("--refresh", "Re-probe the server instead of using the tool cache")
        .action(async (ref: string, opts: { json?: boolean; refresh?: boolean }) => {
            const { matched, errors } = await resolveSelectors([ref], { refresh: opts.refresh });

            if (matched.length === 0) {
                const detail =
                    errors.length > 0 ? ` Servers that failed: ${errors.map((e) => e.server).join(", ")}.` : "";

                throw new Error(`No tool matched '${ref}'.${detail}`);
            }

            if (opts.json) {
                out.result({
                    tools: matched.map(({ server, tool }) => ({
                        ref: `${server}.${tool.name}`,
                        description: tool.description,
                        params: paramsOf(tool.inputSchema),
                        outputSchema: tool.outputSchema,
                    })),
                });
                return;
            }

            for (const { server, tool } of matched) {
                ui.raw("");
                ui.header(`${server}.${tool.name}`);
                ui.raw(`  ${signatureOf(tool.name, tool.inputSchema, 60)}`);

                if (tool.description) {
                    for (const line of tool.description.split("\n")) {
                        ui.raw(pc.dim(`  ${line}`));
                    }
                }

                const params = paramsOf(tool.inputSchema);

                if (params.length === 0) {
                    ui.raw(pc.dim("  (no parameters)"));
                } else {
                    const pad = Math.max(...params.map((p) => p.name.length));
                    const typePad = Math.min(30, Math.max(...params.map((p) => p.type.length)));

                    ui.raw(`  ${pc.bold("params")}`);

                    for (const p of params) {
                        const flag = p.required ? pc.red("required") : pc.dim("optional");
                        const type = p.type.length > 30 ? `${p.type.slice(0, 29)}…` : p.type;

                        ui.raw(
                            `    ${p.name.padEnd(pad)}  ${type.padEnd(typePad)}  ${flag}  ${pc.dim(firstLine(p.desc, 90))}`
                        );
                    }
                }

                ui.raw(
                    pc.dim(`  returns: ${tool.outputSchema ? "structured (outputSchema declared)" : "text blocks"}`)
                );
            }
        });
}
