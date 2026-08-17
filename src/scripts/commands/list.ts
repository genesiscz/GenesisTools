import { suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { filterScripts, readJournal } from "../lib/journal.ts";

interface ListOptions {
    tag?: string[];
    project?: string;
    cwd?: string | boolean;
    server?: string;
    grep?: string;
    all?: boolean;
    json?: boolean;
}

export function registerList(program: Command): void {
    program
        .command("list")
        .description("List persisted scripts. Gated scripts from other projects are hidden unless --all.")
        .option("--tag <tags...>", "Only scripts carrying all of these tags")
        .option("--project <name>", "Only scripts created under this project")
        .option("--cwd [path]", "Only scripts created at or below this directory (bare flag means the current one)")
        .option("--server <name>", "Only scripts bound to this server")
        .option("--grep <text>", "Substring match over name, description, tags and tool refs")
        .option("--all", "Include gated scripts from other projects")
        .option("--json", "Machine-readable output")
        .action(async (opts: ListOptions) => {
            const journal = await readJournal();
            const cwd = opts.cwd === true ? process.cwd() : opts.cwd;
            const baseFilter = {
                tag: opts.tag,
                project: opts.project,
                cwd: typeof cwd === "string" ? cwd : undefined,
                server: opts.server,
                grep: opts.grep,
            };
            const filtered = filterScripts(journal.scripts, { ...baseFilter, all: opts.all });

            if (opts.json) {
                out.result({ scripts: filtered, total: journal.scripts.length });
                return;
            }

            if (filtered.length === 0) {
                ui.raw(
                    `no scripts${journal.scripts.length > 0 ? ` matched (${journal.scripts.length} total)` : " yet"}`
                );
                ui.dim(
                    `create one: ${suggestCommand("tools scripts", { replaceCommand: ["create", "<name>", "--import", "'<server>.*'"] })}`
                );
                return;
            }

            for (const s of filtered) {
                const tags = s.tags.length > 0 ? ` ${pc.dim(`#${s.tags.join(" #")}`)}` : "";
                const gate = s.gateDir ? ` ${pc.yellow("⌂")}` : "";
                ui.raw(`${pc.bold(s.name)}${tags}${gate}`);
                ui.raw(`  ${s.description ?? pc.dim("(no description)")}`);
                ui.raw(
                    pc.dim(
                        `  ${s.servers.join(", ")} · ${s.tools.length} tool(s) · ${s.runs} run(s) · ${s.project ?? "-"}`
                    )
                );
                ui.raw(pc.dim(`  ${s.createdFrom}`));
            }

            const withGated = filterScripts(journal.scripts, { ...baseFilter, all: true });
            const hiddenByGate = withGated.length - filtered.length;
            ui.raw("");
            ui.raw(
                `${filtered.length} of ${journal.scripts.length}${hiddenByGate > 0 ? ` (${hiddenByGate} gated elsewhere; --all shows)` : ""}`
            );
        });
}
