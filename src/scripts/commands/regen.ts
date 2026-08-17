import { ui } from "@genesiscz/utils/cli/ui";
import type { Command } from "commander";
import pc from "picocolors";
import { assertBoundServersResponded, resolveSelectors } from "../lib/discover.ts";
import { getEntry, mutateEntry, scriptPaths } from "../lib/journal.ts";
import { bindNames, renderToolsModule } from "../lib/scaffold.ts";
import { commitStore, ensureStoreScaffold } from "../lib/store.ts";

export function registerRegen(program: Command): void {
    program
        .command("regen <name>")
        .description("Re-probe the servers and rewrite <name>.tools.ts. Your <name>.ts is not touched.")
        .option("--force", "Rewrite bindings even when a previously bound server failed to respond")
        .action(async (name: string, opts: { force?: boolean }) => {
            const entry = await getEntry(name);

            if (!entry) {
                throw new Error(`No script named '${name}'.`);
            }

            if (entry.imports.length === 0) {
                throw new Error(`'${name}' has no imported selectors, so there are no bindings to regenerate.`);
            }

            const { matched, errors } = await resolveSelectors(entry.imports, { refresh: true });

            if (matched.length === 0) {
                throw new Error(`No tools matched ${entry.imports.join(", ")} any more. Bindings left untouched.`);
            }

            assertBoundServersResponded(entry.servers, errors, Boolean(opts.force));

            await ensureStoreScaffold();
            const bound = bindNames(matched);
            const now = new Date().toISOString();
            const { toolsFile } = scriptPaths(name);
            await Bun.write(toolsFile, renderToolsModule(bound, entry.imports, now));

            const before = new Set(entry.tools);
            const after = bound.map((b) => `${b.server}.${b.tool.name}`);
            const added = after.filter((t) => !before.has(t));
            const removed = [...before].filter((t) => !after.includes(t));

            // Field-scoped mutation under the journal lock, so a concurrent
            // run's counter bump between our read and this write survives.
            await mutateEntry(name, (live) => {
                live.tools = after;
                live.servers = [...new Set(bound.map((b) => b.server))];
                live.updatedAt = now;
            });
            await commitStore(`chore: regen ${name} bindings`);

            ui.ok(`regenerated ${after.length} binding(s)`);

            if (added.length > 0) {
                ui.raw(`  ${pc.green("+")} ${added.join(", ")}`);
            }

            if (removed.length > 0) {
                ui.raw(`  ${pc.red("-")} ${removed.join(", ")} ${pc.dim("(callers of these will now fail)")}`);
            }

            for (const e of errors) {
                ui.err(`${e.server}: ${e.error.slice(0, 160)}`);
            }
        });
}
