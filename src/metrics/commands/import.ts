import { existsSync } from "node:fs";
import { out } from "@genesiscz/utils/logger";
import { type Command, Command as SubCommand } from "commander";
import { defaultHooksLogPath, importHooksLog } from "../lib/hooks-log";
import { withService } from "../lib/service";

async function importHooks(path: string | undefined): Promise<void> {
    const file = path ?? defaultHooksLogPath();

    if (!existsSync(file)) {
        out.printlnErr(`No hooks log at ${file}`);
        process.exitCode = 1;
        return;
    }

    await withService(async (client) => {
        const summary = await importHooksLog(client, file);
        out.printlnErr(
            `Imported ${summary.accepted} events from ${summary.lines} lines of ${summary.path} (bytes ${summary.from} to ${summary.to}); ${summary.skipped} skipped, ${summary.bad + summary.rejected} refused`
        );
        out.result(summary);
    });
}

export function registerImportCommand(program: Command): void {
    const group = new SubCommand("import").description("Read an older log into the metrics store");
    group
        .command("hooks-log [path]")
        .description(
            "The mods hook ledger's mods-log/hooks.jsonl into agent-context / hook.injection, one event per line; its offset is kept, so a second run adds only new lines"
        )
        .action((path: string | undefined) => importHooks(path));
    program.addCommand(group);
}
