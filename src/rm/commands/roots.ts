import { out } from "@genesiscz/utils/logger";
import { appendRmLedger, hardDenyReason, realOrSelf, resolveTarget, saveRmConfig } from "@genesiscz/utils/rm";
import type { Command } from "commander";
import pc from "picocolors";
import { requirePerson, runContext } from "../lib/run";

export function registerRootCommands(program: Command): void {
    const roots = program.command("roots").description("folders an agent may delete anything inside");

    roots
        .command("list", { isDefault: true })
        .description("list the trusted roots")
        .option("--json", "print as JSON")
        .action((flags: { json?: boolean }) => {
            const { config } = runContext();

            if (flags.json) {
                out.result(config.roots);
                return;
            }

            if (config.roots.length === 0) {
                out.println("No trusted roots. Add one with: tools rm roots add <dir>");
                return;
            }

            for (const root of config.roots) {
                out.println(`${root.path} ${pc.dim(`${root.via} ${root.addedAt}${root.note ? ` ${root.note}` : ""}`)}`);
            }
        });

    roots
        .command("add")
        .description("trust a folder (a person only: a typed code, or a macOS dialog)")
        .argument("<dir>", "the folder")
        .option("--note <text>", "why it is trusted")
        .action(async (dir: string, flags: { note?: string }) => {
            const ctx = runContext();
            const target = resolveTarget(dir, ctx.cwd);
            const denied = hardDenyReason(target, ctx.rules);

            if (target.kind !== "dir" || denied) {
                out.println(pc.red(`Cannot be a root: ${denied ?? "not a folder"}.`));
                process.exitCode = 1;
                return;
            }

            const answer = await requirePerson(ctx, {
                title: `Let agents delete anything inside ${target.canonical}?`,
                lines: [target.canonical, flags.note ?? ""].filter(Boolean),
                code: "trust",
            });

            if (!answer.approved) {
                return;
            }

            const root = { path: target.canonical, note: flags.note, addedAt: new Date().toISOString(), via: "cli" };
            saveRmConfig({ ...ctx.config, roots: [...ctx.config.roots.filter((r) => r.path !== root.path), root] });
            appendRmLedger({ action: "root-add", path: root.path, via: answer.via, caller: ctx.caller });
            out.println(pc.green(`Trusted ${root.path}.`));
        });

    roots
        .command("remove")
        .description("stop trusting a folder")
        .argument("<dir>", "the folder")
        .action((dir: string) => {
            const ctx = runContext();
            const path = realOrSelf(dir);
            const kept = ctx.config.roots.filter((r) => r.path !== path && r.path !== dir);

            if (kept.length === ctx.config.roots.length) {
                out.println(pc.yellow(`${path} is not a trusted root.`));
                process.exitCode = 1;
                return;
            }

            saveRmConfig({ ...ctx.config, roots: kept });
            appendRmLedger({ action: "root-remove", path, caller: ctx.caller });
            out.println(`No longer trusted: ${path}.`);
        });
}
