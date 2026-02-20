import { getStepCatalog } from "@app/automate/lib/registry";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import "@app/automate/lib/steps";

export function registerStepCommands(parent: Command): void {
    parent
        .command("list", { isDefault: true })
        .alias("ls")
        .description("List all available step types")
        .action(() => {
            p.intro(pc.bgCyan(pc.black(" automate step list ")));

            const catalog = getStepCatalog();
            for (const entry of catalog) {
                const actions = entry.actions.map((a) => pc.dim(a.action)).join(", ");
                p.log.info(`  ${pc.cyan(pc.bold(entry.prefix))} — ${entry.description}\n    ${actions}`);
            }

            p.log.step(`\nRun ${pc.cyan("tools automate step show <action>")} for details on a specific step type.`);
            p.outro("");
        });

    parent
        .command("show <action>")
        .description("Show details for a specific step type or action")
        .action((actionArg: string) => {
            p.intro(pc.bgCyan(pc.black(" automate step show ")));

            const catalog = getStepCatalog();
            const entry = catalog.find((e) => e.prefix === actionArg || e.actions.some((a) => a.action === actionArg));
            if (!entry) {
                p.log.error(`Unknown step type: ${actionArg}`);
                p.log.info(`Available: ${catalog.map((e) => e.prefix).join(", ")}`);
                p.outro("");
                return;
            }

            p.log.step(`${pc.bold(entry.prefix)} — ${entry.description}`);
            for (const action of entry.actions) {
                p.log.info(`\n  ${pc.cyan(action.action)} — ${action.description}`);
                for (const param of action.params) {
                    const req = param.required ? pc.yellow("*") : " ";
                    p.log.info(`    ${req} ${pc.bold(param.name)} — ${pc.dim(param.description)}`);
                }
            }
            p.outro("");
        });
}
