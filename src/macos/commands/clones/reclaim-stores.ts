import { applyLogLevel } from "@app/macos/commands/clones/log-level";
import { parseMinReal } from "@app/macos/lib/clones/min-real";
import { resolveFormat } from "@app/macos/lib/clones/render/index";
import { reportUnreferencedStore } from "@app/macos/lib/clones/store-report";
import { suggestCommand } from "@genesiscz/utils/cli";
import { printLn } from "@genesiscz/utils/cli/stdout";
import { formatBytes } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { createBoxTable } from "@genesiscz/utils/table";
import { Command, Option } from "commander";
import pc from "picocolors";

const DEFAULT_STORE_MIN = 1 << 20;

interface StoresOpts {
    minSize: string;
    format?: string;
    verbose?: boolean;
}

export function createStoresCommand(): Command {
    return new Command("stores")
        .description(
            "Report bun cache entries that no install tree clones (fully private bytes). Report only: it never deletes"
        )
        .option("--min-size <bytes>", "Judge each entry by its files of at least this size", String(DEFAULT_STORE_MIN))
        .addOption(new Option("--format <format>", "Output format").choices(["auto", "table", "json"]).default("auto"))
        .option("-v, --verbose", "Verbose logging", false)
        .action(async (opts: StoresOpts) => {
            applyLogLevel(opts);
            const minBytes = parseMinReal(opts.minSize);
            if (minBytes === null) {
                console.error(`--min-size must be a positive whole number of bytes, got "${opts.minSize}".`);
                console.error(
                    suggestCommand("tools macos clones", {
                        add: ["--min-size", String(DEFAULT_STORE_MIN)],
                        subcommand: ["macos", "clones", "reclaim", "stores"],
                    })
                );
                process.exitCode = 1;
                return;
            }

            const report = await reportUnreferencedStore({ minBytes });
            if (report === null) {
                console.error(
                    "bun cache not found: `bun pm cache` gave no directory, and neither $BUN_INSTALL_CACHE_DIR, " +
                        "$BUN_INSTALL/install/cache nor ~/.bun/install/cache exists."
                );
                process.exitCode = 1;
                return;
            }

            if (resolveFormat(opts.format) !== "table") {
                await printLn(SafeJSON.stringify(report, null, 2));
                return;
            }

            const table = createBoxTable(["ENTRY", "FILES", "PRIVATE"]);
            for (const e of report.entries) {
                table.push([pc.white(e.entry), String(e.files), formatBytes(e.privateBytes)]);
            }

            await printLn(table.toString());
            await printLn(
                `${report.entries.length} unreferenced entr${report.entries.length === 1 ? "y" : "ies"} · ` +
                    `${formatBytes(report.totalPrivate)} fully private · ${report.filesListed} file(s) of at least ` +
                    `${formatBytes(report.minBytes)} read under ${report.store.root}`
            );
            await printLn(
                pc.dim(
                    "Nothing was deleted. Fully private means no file clones it now: a tree holding a plain copy " +
                        "still uses the package, and bun re-downloads a removed entry on the next install that needs it."
                )
            );
        });
}
