import { existsSync } from "node:fs";
import { join } from "node:path";
import { probeIndexedDb } from "@app/ms-teams/lib/probe";
import { quitTeamsApp, teamsAppIsUp } from "@app/ms-teams/lib/process";
import {
    authStatus,
    cacheMovePlan,
    defaultRepairProfile,
    defaultRepairRoot,
    duSh,
    listBackups,
    listDirNames,
    runRepairMove,
    runRestore,
} from "@app/ms-teams/lib/repair";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";

interface RepairOpts {
    yes?: boolean;
    dryRun?: boolean;
    root?: string;
    tmp?: string;
}

function requireYes(opts: RepairOpts, verb: string): void {
    if (opts.dryRun || opts.yes) {
        return;
    }

    if (isInteractive()) {
        out.error(`${verb} is mutating. Pass --yes to confirm.`);
    } else {
        out.error(`${verb} is mutating. Pass --yes (or --dry-run to print the plan).`);
    }

    out.error(suggestCommand("tools ms-teams", { replaceCommand: ["repair", verb, "--yes"] }));
    process.exit(1);
}

function printAuth(profile: string): void {
    const table = createBoxTable(["AUTH DIR", "STATUS"]);

    for (const row of authStatus(profile)) {
        table.push([row.name, formatDotStatus(row.ok ? "ok" : "err", row.ok ? "intact" : "missing")]);
    }

    out.println(table.toString());
}

function printMoveResult(kind: "cache" | "idb", result: ReturnType<typeof runRepairMove>, profile: string): void {
    for (const line of result.lines) {
        out.println(line);
    }

    out.println(`DEST=${result.dest}`);
    printAuth(profile);
    out.println("Relaunch Microsoft Teams. First load is slow. Chats refill from the server.");
    out.println("SQLite at ~/.genesis-tools/ms-teams/cache.db is now stale.");
    out.println("After Teams rebuilds IndexedDB, prove with:");
    out.println(suggestCommand("tools ms-teams", { replaceCommand: ["repair", "probe", "<title>"] }));
    out.println(suggestCommand("tools ms-teams", { replaceCommand: ["sync", "--force"] }));
    out.println("Restore (quit Teams first) if it logs you out or looks worse:");
    out.println(suggestCommand("tools ms-teams", { replaceCommand: ["repair", "restore", result.dest, "--yes"] }));
    out.println("/tmp clears on reboot. Restore window is until the next restart.");

    if (kind === "idb") {
        out.println(
            "Do not run sync --force until live IndexedDB exists again, or the SQLite cache will ingest an empty dump."
        );
    }
}

export function registerRepairCommand(program: Command): void {
    const repair = program.command("repair").description("Reset New Teams live cache without logging out");

    repair
        .command("status")
        .description("Live profile sizes, auth dirs, backups. Does not write.")
        .option("--root <path>", "MSTeams folder")
        .action((opts: { root?: string }) => {
            const root = opts.root ?? defaultRepairRoot();
            const eb = join(root, "EBWebView");
            const profile = join(eb, "WV2Profile_tfw");
            renderCliHeader("Teams live profile", "IndexedDB is the conversation store");
            const table = createBoxTable(["CHECK", "STATUS"]);
            table.push(["root", existsSync(root) ? root : "MISSING"]);
            const appUp = teamsAppIsUp();
            table.push(["app", formatDotStatus(appUp ? "warn" : "ok", appUp ? "UP (quit before repair)" : "down")]);
            table.push(["WV2Profile_tfw", existsSync(profile) ? duSh(profile) : "MISSING"]);
            out.println(table.toString());

            if (!existsSync(profile)) {
                return;
            }

            printAuth(profile);
            const cacheTable = createBoxTable(["TIER-1 CACHE", "SIZE"]);

            for (const item of cacheMovePlan(eb, profile)) {
                cacheTable.push([item.destName, existsSync(item.src) ? duSh(item.src) : "absent"]);
            }

            out.println(cacheTable.toString());
            const indexedDb = join(profile, "IndexedDB");
            const idbTable = createBoxTable(["INDEXEDDB", "SIZE"]);
            const names = listDirNames(indexedDb);

            if (names.length === 0) {
                idbTable.push(["(empty)", "—"]);
            }

            for (const name of names) {
                idbTable.push([name, duSh(join(indexedDb, name))]);
            }

            out.println(idbTable.toString());
            const backups = listBackups();
            const backupTable = createBoxTable(["BACKUP", "SIZE"]);

            if (backups.length === 0) {
                backupTable.push(["(none)", "—"]);
            }

            for (const b of backups) {
                backupTable.push([b, duSh(b)]);
            }

            out.println(backupTable.toString());
            out.println("If old chats vanished while still logged in: repair idb, not cache.");
        });

    repair
        .command("probe <text...>")
        .description("Search the live IndexedDB files for a conversation title (not the SQLite cache)")
        .option("--root <path>", "MSTeams folder")
        .option("--json", "Machine-readable JSON")
        .action((textParts: string[], opts: { root?: string; json?: boolean }) => {
            const needle = textParts.join(" ").trim();
            const indexedDbDir = opts.root ? join(opts.root, "EBWebView", "WV2Profile_tfw", "IndexedDB") : undefined;
            const result = probeIndexedDb({ needle, indexedDbDir });

            if (opts.json) {
                out.result(result);
                return;
            }

            renderCliHeader("Teams live probe", needle);
            out.println(`IndexedDB ${result.present ? "present" : "MISSING"} at ${result.indexedDbDir}`);
            out.println(`files scanned ${result.filesScanned}`);
            out.println(`hits ${result.hits.length}`);

            for (const hit of result.hits.slice(0, 8)) {
                out.println(`  ${hit.encoding}  ${hit.file}`);
            }

            if (result.hits.length === 0) {
                out.println("Needle not in live IndexedDB. SQLite may still show a stale hit until sync --force.");
            }
        });

    repair
        .command("quit")
        .description("Quit Microsoft Teams (not logout). Ignores the audio driver.")
        .action(async () => {
            const result = await quitTeamsApp();
            out.println(
                result.alreadyDown
                    ? "New Teams is already down. Audio driver / widget may still show in pgrep. That is fine."
                    : "New Teams quit."
            );
        });

    repair
        .command("idb")
        .description("Move the teams.microsoft.com IndexedDB aside (conversation store). Keeps login.")
        .option("-y, --yes", "Confirm the move")
        .option("--dry-run", "Print the plan, move nothing")
        .option("--root <path>", "MSTeams folder")
        .option("--tmp <dir>", "Backup parent", "/tmp")
        .action((opts: RepairOpts) => {
            requireYes(opts, "idb");
            const profile = opts.root ? join(opts.root, "EBWebView", "WV2Profile_tfw") : defaultRepairProfile();
            const result = runRepairMove({
                kind: "idb",
                root: opts.root,
                tmpDir: opts.tmp,
                dryRun: opts.dryRun,
            });
            printMoveResult("idb", result, profile);
        });

    repair
        .command("cache")
        .description("Move Service Worker + GPU caches aside. Did not restore vanished chats on 2026-07-23 12:46.")
        .option("-y, --yes", "Confirm the move")
        .option("--dry-run", "Print the plan, move nothing")
        .option("--root <path>", "MSTeams folder")
        .option("--tmp <dir>", "Backup parent", "/tmp")
        .action((opts: RepairOpts) => {
            requireYes(opts, "cache");
            const profile = opts.root ? join(opts.root, "EBWebView", "WV2Profile_tfw") : defaultRepairProfile();
            const result = runRepairMove({
                kind: "cache",
                root: opts.root,
                tmpDir: opts.tmp,
                dryRun: opts.dryRun,
            });
            printMoveResult("cache", result, profile);
        });

    repair
        .command("restore <dest>")
        .description("Move a /tmp/teams-{idb,cache}-* backup back into the live profile")
        .option("-y, --yes", "Confirm the restore")
        .option("--dry-run", "Print the plan, move nothing")
        .option("--root <path>", "MSTeams folder")
        .action((dest: string, opts: RepairOpts) => {
            requireYes(opts, "restore");
            const result = runRestore({ dest, root: opts.root, dryRun: opts.dryRun });
            out.println(`backup kind=${result.kind}`);

            for (const line of result.lines) {
                out.println(line);
            }
        });
}
