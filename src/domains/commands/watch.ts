import { infoCell, money, statusCell } from "@app/domains/lib/display";
import { gatherNames, reportInvalid } from "@app/domains/lib/input";
import { addWatch, listWatch, refreshWatch, removeWatch } from "@app/domains/lib/watch";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable } from "@genesiscz/utils/table";
import { Command } from "commander";
import pc from "picocolors";

export function createWatchCommand(): Command {
    const watch = new Command("watch").description("Keep a list of names and get told when they change or expire");

    watch
        .command("add")
        .description("Add names to the watchlist")
        .argument("[domains...]", "domain names (also --file or stdin)")
        .option("--file <path>", "read names from a file")
        .option("--note <text>", "why you watch it")
        .action(async (domains: string[], opts) => {
            const { added, invalid } = await addWatch(await gatherNames({ args: domains, file: opts.file }), opts.note);
            reportInvalid(invalid);
            out.log.success(added.length ? `Watching ${added.join(", ")}` : "Nothing new to watch.");
        });

    watch
        .command("ls")
        .alias("list")
        .description("Show the watchlist with the last known state (no network)")
        .option("--json", "print JSON to stdout")
        .action(async (opts) => {
            const entries = await listWatch();
            if (opts.json) {
                out.result({ watch: entries });
                return;
            }

            if (entries.length === 0) {
                out.log.info("The watchlist is empty. Add names: tools domains watch add genesis.tech");
                return;
            }

            const table = createBoxTable(["DOMAIN", "LAST STATUS", "PRICE", "EXPIRES", "CHECKED", "NOTE"]);
            for (const entry of entries) {
                table.push([
                    pc.white(entry.domain),
                    entry.lastStatus ? statusCell(entry.lastStatus) : pc.dim("never checked"),
                    money(entry.price),
                    entry.expiresAt?.slice(0, 10) ?? pc.dim("—"),
                    pc.dim(entry.lastCheckedAt?.slice(0, 16).replace("T", " ") ?? "—"),
                    pc.dim(entry.note ?? ""),
                ]);
            }

            out.println(table.toString());
        });

    watch
        .command("rm")
        .alias("remove")
        .description("Remove names from the watchlist")
        .argument("<domains...>", "domain names")
        .action(async (domains: string[]) => {
            const removed = await removeWatch(domains);
            out.log.success(removed.length ? `Removed ${removed.join(", ")}` : "None of those were watched.");
        });

    watch
        .command("refresh")
        .description("Re-check every watched name, store the new state, and report what changed")
        .option("--expiry-days <n>", "warn when a name expires within this many days", "45")
        .option("--changed", "show only names with something to report")
        .option("--json", "print JSON to stdout")
        .action(async (opts) => {
            const spinner = opts.json ? null : out.spinner();
            spinner?.start("Re-checking the watchlist");
            const changes = await refreshWatch({ expiryWarnDays: Number.parseInt(opts.expiryDays, 10) || 45 });
            spinner?.stop(`Checked ${changes.length} name(s)`);
            const shown = opts.changed ? changes.filter((change) => change.reasons.length) : changes;

            if (opts.json) {
                out.result({ changes: shown });
                return;
            }

            const table = createBoxTable(["DOMAIN", "STATUS", "INFO", "NEWS"]);
            for (const change of shown) {
                table.push([
                    pc.white(change.entry.domain),
                    statusCell(change.result.status),
                    infoCell(change.result),
                    change.reasons.length ? pc.yellow(change.reasons.join("; ")) : pc.dim("no change"),
                ]);
            }

            out.println(table.toString());
            if (changes.some((change) => change.reasons.length)) {
                process.exitCode = 3;
            }
        });

    return watch;
}
